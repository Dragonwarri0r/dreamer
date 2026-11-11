import base64, hashlib, importlib.util, io, json, os, pathlib, signal, subprocess, sys, tempfile, threading, time, unittest, uuid, wave
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'workers/video'))
from worker import Engine, atomic
sys.path.insert(0,str(ROOT/'workers/h3'))
from config import validate_request, snapshot, PROFILES
from memory_policy import resource_stop, launch_flags
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('h3_run',ROOT/'workers/h3/run.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
from PIL import Image

def request(**kw):
    return dict(requestId=str(uuid.uuid4()),fingerprint='test',profile='h3-quality/v1',prompt='A person smiles.',seed=42,**kw)
def cap(): return dict(available=True,fingerprint='test')

class H3Contract(unittest.TestCase):
    def setUp(self):
        self.lockroot=tempfile.TemporaryDirectory();self.oldlock=os.environ.get('DREAMER_GPU_LOCK')
        os.environ['DREAMER_GPU_LOCK']=str(pathlib.Path(self.lockroot.name)/'gpu.lock')
    def tearDown(self):
        if self.oldlock is None: os.environ.pop('DREAMER_GPU_LOCK',None)
        else: os.environ['DREAMER_GPU_LOCK']=self.oldlock
        self.lockroot.cleanup()
    def test_swap_growth_does_not_reject_but_persistent_pressure_does(self):
        with patch.dict(os.environ,{'DREAMER_H3_MEMORY_POLICY':'swap-friendly'}): self.assertEqual(launch_flags(),['--skip-mem-preflight'])
        with patch.dict(os.environ,{'DREAMER_H3_MEMORY_POLICY':'strict'}): self.assertEqual(launch_flags(),[])
        sample={'pressure':'1','diskFreeBytes':10*1024**3,'swapBytes':16*1024**3}
        self.assertEqual(resource_stop(sample,0),(0,None))
        sample['pressure']='4';count=0
        for _ in range(11):
            count,reason=resource_stop(sample,count);self.assertIsNone(reason)
        self.assertEqual(resource_stop(sample,count)[1],'SUSTAINED_CRITICAL_PRESSURE')
        sample['pressure']='1';self.assertEqual(resource_stop(sample,count),(0,None))
        sample['diskFreeBytes']=1024;self.assertEqual(resource_stop(sample,0)[1],'DISK_RESERVE')

    def test_invalid_requests(self):
        for changes in [{'profile':'missing'},{'seed':True},{'seed':-1},{'prompt':''},{'prompt':' \n\t'},{'prompt':'甲'*4001},{'prompt':'\ud800'},{'prompt':'\udc00'},{'references':[{'sha256':'../bad','frame':0}]},{'unexpected':1}]:
            value=request();value.update(changes)
            with self.assertRaises((ValueError,TypeError)):validate_request(value)

    def test_canvas_memory_failure_and_legacy_preflight_classification(self):
        canvas='480x832 x 124 frames needs ~17.8 GB (11.3 GB DiT + 6.4 GB for 14844 sequence rows) but 16.2 GB is available: use a smaller canvas or fewer frames'
        code,detail,estimate=runner.failure_details(canvas)
        self.assertEqual(code,'MEMORY_PREFLIGHT')
        self.assertEqual(estimate,{'requiredGiB':17.8,'availableGiB':16.2})
        self.assertIn('17.8 GiB',detail);self.assertIn('16.2 GiB',detail)
        self.assertIn('低分辨率原生音画预览',detail);self.assertIn('未自动重试或降级',detail)
        legacy='Model needs ~17.6 GB free (weights + warmup headroom), but only 15.4 GB is available'
        self.assertEqual(runner.failure_details(legacy)[0],'MEMORY_PREFLIGHT')
        self.assertEqual(runner.memory_estimate(legacy),{'requiredGiB':17.6,'availableGiB':15.4})
        self.assertEqual(runner.failure_details('InsufficientMemory')[0],'MEMORY_PREFLIGHT')
        self.assertEqual(runner.failure_details('AUDIO_CONTRACT: native audio duration mismatch')[0],'GENERATION_FAILED')
        self.assertIsNone(runner.memory_estimate('AUDIO_CONTRACT: native audio duration mismatch'))

    def test_http_canvas_rejection_preserves_failed_receipt_without_retry_or_downgrade(self):
        message='480x832 x 124 frames needs ~17.8 GB (11.3 GB DiT + 6.4 GB for 14844 sequence rows) but 16.2 GB is available: use a smaller canvas or fewer frames'
        body=json.dumps({'error':{'message':message}}).encode()
        error=runner.urllib.error.HTTPError('http://127.0.0.1/v1/video/generations',400,'Error',{},io.BytesIO(body))
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);value=request();atomic(root/'request.json',value)
            with patch.object(runner,'describe',return_value=cap()), patch.object(runner,'payload',side_effect=error) as payload, patch.object(runner.subprocess,'Popen') as process, patch.object(runner,'sample',return_value={'diskFreeBytes':10*1024**3}), patch.object(runner.signal,'signal'), patch('builtins.print'):
                self.assertEqual(runner.main(root),1)
            payload.assert_called_once();process.assert_not_called()
            result=json.loads((root/'result.json').read_text())
            self.assertEqual(result['state'],'failed')
            self.assertEqual(result['performance']['profile'],'h3-quality/v1')
            self.assertEqual(result['performance']['errorCode'],'MEMORY_PREFLIGHT')
            self.assertEqual(result['performance']['memoryPreflight'],{'requiredGiB':17.8,'availableGiB':16.2})
            self.assertIn(message,result['performance']['error'])
            self.assertIn('未自动重试或降级',result['detail'])
            self.assertEqual(json.loads((root/'request.json').read_text()),value)
            self.assertFalse((root/'output.mp4').exists())
            self.assertNotIn('generationSeconds',result['performance'])

    def test_native_chinese_dialogue_and_unicode_reach_model_payload_unchanged(self):
        prompt='integrated_multimodal_description: [Shot 1] Jipiti (S1) says: <d>[Chinese]别急，先数清楚。</d>\noverall_soundscape: Steam hisses.\nnon_diegetic_music: N/A'
        with tempfile.TemporaryDirectory() as tmp:
            for text in [prompt,'A person smiles.','角色转头，然后说：你好。','🪶'*4000]:
                value=request();value['prompt']=text
                self.assertEqual(validate_request(value)['prompt'],text)
                wire=runner.payload(value,pathlib.Path(tmp))
                self.assertEqual(json.loads(json.dumps(wire).encode('utf-8'))['prompt'],text)

    def test_reference_snapshot_and_wire_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);(root/'references').mkdir();job=root/'job';job.mkdir()
            image=root/'input.png';Image.new('RGB',(64,64),'yellow').save(image);data=image.read_bytes();digest=hashlib.sha256(data).hexdigest()
            source=root/'references'/(digest+'.png');source.write_bytes(data)
            value=request(references=[{'sha256':digest,'frame':0},{'sha256':digest,'frame':123}])
            snapshot(value,root,job);source.unlink()
            wire=runner.payload(value,job)
            self.assertEqual(base64.b64decode(wire['first_frame_image']),data)
            self.assertEqual(wire['last_frame_image'],wire['first_frame_image'])
            self.assertEqual((wire['steps'],wire['turbo'],wire['fast'],wire['num_frames']),(16,False,False,124))
            (job/'references/0.png').write_bytes(b'corrupt')
            with self.assertRaises(ValueError):runner.payload(value,job)

    def test_receipt_recovery_idempotency(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);a=Engine(root,capability=cap,validator=validate_request,snapshot=snapshot)
            value=request();a.submit(value)
            self.assertEqual(a.submit(value)['state'],'queued')
            altered={**value,'prompt':'Different'}
            with self.assertRaises(ValueError):a.submit(altered)
            atomic(root/value['requestId']/'state.json',{'requestId':value['requestId'],'state':'running'})
            a.lockfile.close();a.gpu_lock.close()
            b=Engine(root,capability=cap,validator=validate_request,snapshot=snapshot)
            self.assertEqual(b.get(value['requestId'])['state'],'outcome_unknown')
            atomic(root/value['requestId']/'result.json',{'requestId':value['requestId'],'fingerprint':'wrong','state':'completed'})
            with self.assertRaises(ValueError):b.get(value['requestId'])
            atomic(root/value['requestId']/'result.json',{'requestId':value['requestId'],'fingerprint':'test','state':'failed','detail':'Memory preflight'})
            self.assertEqual(b.get(value['requestId'])['detail'],'Memory preflight')
            b.lockfile.close();b.gpu_lock.close()

    def test_orphan_cancel_requires_released_gpu_lock(self):
        import fcntl
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);e=Engine(root,capability=cap,validator=validate_request,snapshot=snapshot)
            v=request();e.submit(v)
            atomic(root/v['requestId']/'state.json',{'requestId':v['requestId'],'state':'outcome_unknown'})
            with open(os.environ['DREAMER_GPU_LOCK'],'a') as owned:
                fcntl.flock(owned,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertEqual(e.cancel(v['requestId'])['state'],'outcome_unknown')
            self.assertEqual(e.get(v['requestId'])['state'],'cancelled')
            e.lockfile.close();e.gpu_lock.close()

    def test_gpu_mutex_and_owned_process_group_cancel(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);script=root/'fake.py'
            script.write_text("import subprocess,sys,time,pathlib\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'])\npathlib.Path(sys.argv[1],'child.pid').write_text(str(p.pid))\ntime.sleep(90)\n")
            a=Engine(root/'a',runner=script,capability=cap,validator=validate_request,snapshot=snapshot)
            b=Engine(root/'b',runner=script,capability=cap,validator=validate_request,snapshot=snapshot)
            av=request();bv=request();a.submit(av);b.submit(bv)
            t=threading.Thread(target=a.tick);t.start()
            path=root/'a'/av['requestId']/'child.pid'
            for _ in range(100):
                if path.exists():break
                time.sleep(.02)
            self.assertTrue(path.exists());b.tick();self.assertEqual(b.get(bv['requestId'])['state'],'queued')
            a.cancel(av['requestId']);t.join(8);self.assertFalse(t.is_alive())
            self.assertEqual(a.get(av['requestId'])['state'],'cancelled')
            child=int(path.read_text())
            # A zombie awaiting OS reaping cannot execute; no live descendant may remain.
            status=subprocess.run(['ps','-o','stat=','-p',str(child)],capture_output=True,text=True).stdout.strip()
            self.assertTrue(not status or status.startswith('Z'),status)
            b.cancel(bv['requestId'])
            for e in [a,b]: e.lockfile.close();e.gpu_lock.close()

    def test_media_contract_and_real_mux(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);p={'width':64,'height':64,'frames':2,'fps':24}
            event={'format':'rgb8','width':64,'height':64,'frames':2,'fps':24,'data':base64.b64encode(bytes([200,150,50])*64*64*2).decode(),
                   'audio_format':'pcm_s16le','audio_channels':2,'audio_sample_rate':32000,'audio_data':base64.b64encode(bytes(10668)).decode()}
            with self.assertRaises(ValueError):runner.mux({**event,'frames':3},root,p)
            with self.assertRaises(ValueError):runner.mux({**event,'data':'AAAA'},root,p)
            runner.mux(dict(event),root,p)
            self.assertGreater((root/'output.mp4').stat().st_size,100)
            self.assertTrue((root/'native-audio.wav').is_file())
            with wave.open(str(root/'native-audio.wav')) as audio:
                self.assertEqual((audio.getframerate(),audio.getnchannels()),(32000,2))
            self.assertFalse((root/'frames.rgb').exists())
            self.assertFalse((root/'native-audio.pcm').exists())

    def test_mux_failure_retains_both_model_outputs_for_repackaging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);p={'width':64,'height':64,'frames':2,'fps':24}
            event={'format':'rgb8',**p,'data':base64.b64encode(bytes([200,150,50])*64*64*2).decode(),
                   'audio_format':'pcm_s16le','audio_channels':2,'audio_sample_rate':32000,'audio_data':base64.b64encode(bytes(10668)).decode()}
            with patch.dict(os.environ,{'DREAMER_FFMPEG':'/usr/bin/false'}):
                with self.assertRaises(subprocess.CalledProcessError): runner.mux(event,root,p)
            self.assertEqual((root/'native-audio.pcm').stat().st_size,10668)
            self.assertEqual((root/'frames.rgb').stat().st_size,64*64*2*3)
            self.assertEqual(json.loads((root/'response-metadata.json').read_text())['audio_sample_rate'],32000)
            (root/'mux-output.mp4').write_bytes(b'incomplete mux output')
            runner.mux_saved(root,p)
            self.assertGreater((root/'output.mp4').stat().st_size,100)
            with self.assertRaises(FileExistsError): runner.mux_saved(root,p)

    def test_runner_crash_does_not_leave_gpu_descendant(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);script=root/'crash.py'
            script.write_text("import subprocess,sys,os,pathlib\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'],pass_fds=(int(os.environ['DREAMER_GPU_LOCK_FD']),))\npathlib.Path(sys.argv[1],'child.pid').write_text(str(p.pid))\nos._exit(1)\n")
            e=Engine(root/'worker',runner=script,capability=cap,validator=validate_request,snapshot=snapshot)
            v=request();e.submit(v);e.tick()
            self.assertEqual(e.get(v['requestId'])['state'],'failed')
            child=int((root/'worker'/v['requestId']/'child.pid').read_text())
            status=subprocess.run(['ps','-o','stat=','-p',str(child)],capture_output=True,text=True).stdout.strip()
            self.assertTrue(not status or status.startswith('Z'),status)
            e.lockfile.close();e.gpu_lock.close()

if __name__=='__main__':unittest.main()
