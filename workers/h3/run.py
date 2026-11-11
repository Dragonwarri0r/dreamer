"""One owned MLX server per job. Swap-friendly execution, owned processes, no automatic retries."""
import base64, hashlib, json, os, pathlib, re, secrets, shutil, signal, socket, subprocess, sys, threading, time, urllib.error, urllib.request, wave
from memory_policy import memory_policy, launch_flags, resource_stop
from config import ROOT, MODEL, RUNTIME, PROFILES, MODEL_REVISION, RUNTIME_REVISION, describe, validate_request
sys.path.insert(0,str(ROOT/'workers/video'))
from reference_assets import check_png
from worker import atomic

class Stopped(BaseException): pass

def sample(pid=None):
    out={'time':time.time(),'diskFreeBytes':shutil.disk_usage(ROOT).free}
    for key,args in [('swap',['sysctl','vm.swapusage']),('pressure',['sysctl','-n','kern.memorystatus_vm_pressure_level'])]:
        try: out[key]=subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL,timeout=3).strip()
        except (OSError,subprocess.SubprocessError): out[key]=None
    match=re.search(r'used = ([0-9.]+)M',out.get('swap') or '')
    out['swapBytes']=int(float(match[1])*1024**2) if match else None
    if pid:
        try: out['rssBytes']=int(subprocess.check_output(['ps','-o','rss=','-p',str(pid)],text=True,timeout=3).strip())*1024
        except (ValueError,OSError,subprocess.SubprocessError): pass
    return out

def payload(request,directory):
    validate_request(request);p=PROFILES[request['profile']]
    value={'model':MODEL.name,'prompt':request['prompt'],'width':p['width'],'height':p['height'],
           'num_frames':p['frames'],'steps':p['steps'],'seed':request['seed'],'turbo':p['turbo'],
           'fast':False,'stream':True}
    for i,ref in enumerate(request.get('references',[])):
        path=directory/'references'/f'{i}.png';check_png(path,ref['sha256'])
        value[['first_frame_image','last_frame_image'][i]]=base64.b64encode(path.read_bytes()).decode()
    return value

def mux(event,directory,profile):
    # Preserve both model outputs before validation/muxing so a packaging failure
    # can be repaired without another expensive generation.
    raw=base64.b64decode(event.pop('data'),validate=True)
    pcm=base64.b64decode(event.pop('audio_data'),validate=True)
    (directory/'frames.rgb').write_bytes(raw)
    (directory/'native-audio.pcm').write_bytes(pcm)
    atomic(directory/'response-metadata.json',event)
    del raw,pcm
    mux_saved(directory,profile)

def mux_saved(directory,profile):
    if (directory/'output.mp4').exists(): raise FileExistsError('Completed media must not be overwritten')
    event=json.loads((directory/'response-metadata.json').read_text())
    expected=(profile['width'],profile['height'],profile['frames'],profile['fps'])
    if event.get('format')!='rgb8' or tuple(event.get(k) for k in ['width','height','frames','fps'])!=expected:
        raise ValueError('VIDEO_CONTRACT: output dimensions/frames/fps differ from the accepted profile')
    if (directory/'frames.rgb').stat().st_size!=profile['width']*profile['height']*profile['frames']*3: raise ValueError('VIDEO_CONTRACT: RGB length mismatch')
    if event.get('audio_format')!='pcm_s16le' or event.get('audio_channels')!=2 or event.get('audio_sample_rate') not in [24000,32000,44100,48000]:
        raise ValueError('AUDIO_CONTRACT: expected native stereo PCM at a supported sample rate')
    pcm=(directory/'native-audio.pcm').read_bytes()
    duration=len(pcm)/4/event['audio_sample_rate']
    if len(pcm)%4 or abs(duration-profile['frames']/profile['fps'])>.25: raise ValueError('AUDIO_CONTRACT: native audio duration mismatch')
    with wave.open(str(directory/'native-audio.wav'),'wb') as output:
        output.setnchannels(2);output.setsampwidth(2);output.setframerate(event['audio_sample_rate']);output.writeframes(pcm)
    del pcm
    ffmpeg=os.environ.get('DREAMER_FFMPEG',str(ROOT/'.local/bin/ffmpeg'))
    if not pathlib.Path(ffmpeg).exists(): ffmpeg=str(ROOT/'node_modules/ffmpeg-static/ffmpeg')
    args=[ffmpeg,'-nostdin','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f"{profile['width']}x{profile['height']}",
          '-r',str(profile['fps']),'-i',str(directory/'frames.rgb'),'-i',str(directory/'native-audio.wav'),
          '-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',str(directory/'mux-output.mp4')]
    with (directory/'mux.log').open('w') as log: subprocess.run(args,check=True,stdout=log,stderr=log,timeout=120)
    (directory/'mux-output.mp4').replace(directory/'output.mp4')
    (directory/'frames.rgb').unlink()
    (directory/'native-audio.pcm').unlink()

def memory_estimate(message):
    match=re.search(r'needs\s*~([0-9]+(?:\.[0-9]+)?)\s*GB(?:\s+free)?[^\r\n]*?but(?:\s+only)?\s+([0-9]+(?:\.[0-9]+)?)\s*GB\s+is available',message,re.IGNORECASE)
    return {'requiredGiB':float(match[1]),'availableGiB':float(match[2])} if match else None

def failure_details(message):
    estimate=memory_estimate(message);lower=message.lower()
    preflight=estimate is not None or any(s in lower for s in ['insufficientmemory','insufficient memory','memory budget','headroom','preflight'])
    code='MEMORY_PREFLIGHT' if preflight else 'GENERATION_FAILED'
    detail='H3 未生成完整媒体，请查看执行回执。'
    if preflight:
        detail='H3 内存预检未通过；请释放其他 GPU / 内存负载后显式重试。'
        if estimate and 'use a smaller canvas or fewer frames' in lower:
            detail=f"H3 画幅与帧数的内存预检未通过：预计需要 {estimate['requiredGiB']:g} GiB，当前可用 {estimate['availableGiB']:g} GiB。可释放其他内存负载，或明确选择低分辨率原生音画预览重新提交；本次任务未自动重试或降级。"
    return code,detail,estimate

def main(directory):
    request=json.loads((directory/'request.json').read_text());validate_request(request)
    cap=describe()
    result={'requestId':request['requestId'],'fingerprint':request['fingerprint'],'state':'failed',
            'performance':{'modelRevision':MODEL_REVISION,'runtimeRevision':RUNTIME_REVISION,'profile':request['profile'],
                           'contentQualityAccepted':False,'memoryPolicy':memory_policy(),'startedAt':time.time()}}
    server=None;done=threading.Event();monitor=None;aborted=[];samples=[];baseline=sample()
    def stop(*_): raise Stopped()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:
        if not cap['available'] or cap['fingerprint']!=request['fingerprint']: raise ValueError('ASSET_CHANGED: recheck H3 assets')
        body=payload(request,directory)
        # Do not write duplicated base64 references or the private API token to logs.
        atomic(directory/'generation.json',{k:v for k,v in body.items() if not k.endswith('_image')})
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
        origin=f'http://127.0.0.1:{port}';token=secrets.token_hex(32)
        def call(path,data=None,timeout=3):
            req=urllib.request.Request(origin+path,data=json.dumps(data).encode() if data is not None else None,
                 headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
            return urllib.request.urlopen(req,timeout=timeout)
        inherited=tuple([int(os.environ['DREAMER_GPU_LOCK_FD'])]) if 'DREAMER_GPU_LOCK_FD' in os.environ else ()
        with (directory/'server.log').open('w') as log:
            server=subprocess.Popen([str(RUNTIME),'--serve','--host','127.0.0.1','--port',str(port),
                '--model-dir',str(MODEL.parent),'--metrics','--api-key-env','DREAMER_H3_PRIVATE_KEY','--api-key-strict','--log-file','off',*launch_flags()],
                cwd=directory,stdout=log,stderr=log,pass_fds=inherited,
                env={**os.environ,'DREAMER_H3_PRIVATE_KEY':token,'MLX_SERVE_H3_RESIDENT':'0'})
        def watch():
            bad=0
            with (directory/'resources.jsonl').open('w') as log:
                while not done.is_set():
                    entry=sample(server.pid);samples.append(entry);log.write(json.dumps(entry)+'\n');log.flush()
                    bad,reason=resource_stop(entry,bad)
                    if reason:
                        aborted.append(reason)
                        server.terminate();return
                    done.wait(5)
        monitor=threading.Thread(target=watch,daemon=True);monitor.start()
        for _ in range(60):
            if server.poll() is not None: raise RuntimeError('RUNTIME_START: MLX server stopped; see server.log')
            try:
                with call('/v1/models') as response: models=json.load(response)
                if any(m['id']==MODEL.name for m in models['data']): break
            except (OSError,ValueError,KeyError): pass
            time.sleep(1)
        else: raise RuntimeError('RUNTIME_START: pinned model was not registered')
        try:
            with urllib.request.urlopen(origin+'/v1/models',timeout=3): pass
        except urllib.error.HTTPError as error:
            if error.code not in [401,403]: raise
        else: raise RuntimeError('AUTH_REQUIRED: private MLX server accepted an unauthenticated request')
        started=time.time();completed=False
        with call('/v1/video/generations',body,timeout=10500) as response,(directory/'events.jsonl').open('w') as events:
            while True:
                raw=response.readline(240*1024*1024)
                if not raw: break
                if len(raw)>=240*1024*1024: raise ValueError('SSE event exceeds bounded output size')
                if not raw.startswith(b'data: '): continue
                event=json.loads(raw[6:]);kind=event.get('type')
                metadata={k:v for k,v in event.items() if k not in ['data','audio_data','preview']}
                events.write(json.dumps({'elapsedSeconds':time.time()-started,**metadata})+'\n');events.flush()
                if kind=='error': raise RuntimeError(str(event.get('message',event)))
                if kind=='complete':
                    mux(event,directory,PROFILES[request['profile']]);completed=True;break
        if not completed: raise RuntimeError('INCOMPLETE: stream ended without a complete media response')
        result.update(state='completed',outputSha256=hashlib.sha256((directory/'output.mp4').read_bytes()).hexdigest(),audioSha256=hashlib.sha256((directory/'native-audio.wav').read_bytes()).hexdigest())
        result['performance'].update(generationSeconds=time.time()-started,nativeAudio=True,steps=body['steps'],turbo=body['turbo'])
    except Stopped:
        result.update(state='cancelled',detail='本次 H3 推理进程已停止')
    except Exception as error:
        message=str(error)
        if isinstance(error,urllib.error.HTTPError): message+=' '+error.read(16384).decode(errors='replace')
        code,detail,estimate=failure_details(message)
        result.update(detail=detail)
        result['performance'].update(errorCode=code,error=message)
        if estimate: result['performance']['memoryPreflight']=estimate
    finally:
        # A failure is terminal only after our server is confirmed stopped.
        done.set()
        if server and server.poll() is None:
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired: server.kill();server.wait()
        if monitor: monitor.join(timeout=5)
        log_path=directory/'server.log'
        log_text=log_path.read_text(errors='replace') if log_path.exists() else ''
        memory=memory_estimate(log_text)
        if memory and 'memoryPreflight' not in result['performance']:
            result['performance']['memoryPreflight']=memory
        result['performance'].update(baseline=baseline,after=sample(),resourceStop=aborted,
            sampledPeakRssBytes=max((s.get('rssBytes',0) for s in samples),default=0),finishedAt=time.time())
        atomic(directory/'result.json',result)
    print(json.dumps(result),flush=True)
    return 0 if result['state']=='completed' else 1

if __name__=='__main__': raise SystemExit(main(pathlib.Path(sys.argv[1]).resolve()))
