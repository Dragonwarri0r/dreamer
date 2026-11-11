"""Authenticated loopback worker with durable, idempotent requests and one GPU slot."""
import fcntl, hashlib, hmac, importlib.metadata, json, os, pathlib, platform, secrets, signal, subprocess, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from reference_assets import PROFILES, validate_references, snapshot_references
ROOT=pathlib.Path(__file__).resolve().parents[2]
PROFILE='ltx-mps-sample/v1'
def atomic(file,value):
 tmp=file.with_suffix('.tmp');tmp.write_text(json.dumps(value));tmp.chmod(0o600);tmp.replace(file)
def validate_request(value):
 required={'requestId','fingerprint','profile','prompt','seed'}
 if not required<=set(value) or set(value)-required-{'references'}: raise ValueError('Unknown or missing fields')
 if str(uuid.UUID(value['requestId']))!=value['requestId']: raise ValueError('Invalid request ID')
 if value['profile'] not in PROFILES or not isinstance(value['fingerprint'],str): raise ValueError('Unsupported profile')
 if not isinstance(value['prompt'],str) or not 1<=len(value['prompt'])<=4000 or not value['prompt'].isascii(): raise ValueError('An English motion prompt is required')
 if type(value['seed']) is not int or not 0<=value['seed']<2**31: raise ValueError('Invalid seed')
 validate_references(value)
 return value
class Engine:
 def __init__(self,root,runner=None,capability=None,validator=validate_request,snapshot=snapshot_references,timeout=1800):
  self.root=pathlib.Path(root);self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
  self.lockfile=(self.root/'worker.lock').open('a');fcntl.flock(self.lockfile,fcntl.LOCK_EX|fcntl.LOCK_NB)
  gpu_path=pathlib.Path(os.environ.get('DREAMER_GPU_LOCK',str(ROOT/'.local/video-gpu.lock')));gpu_path.parent.mkdir(parents=True,exist_ok=True)
  self.gpu_lock=gpu_path.open('a');self.validator=validator;self.snapshot=snapshot;self.timeout=timeout
  self.guard=threading.RLock();self.runner=runner or ROOT/'workers/video/run.py';self.capability=capability
  if not capability:
   import torch
   self.hardware={'architecture':platform.machine(),'macOS':platform.mac_ver()[0],'mpsAvailable':torch.backends.mps.is_available()}
  tokenfile=self.root/'token'
  if not tokenfile.exists(): tokenfile.write_text(secrets.token_hex(32));tokenfile.chmod(0o600)
  self.token=tokenfile.read_text().strip();self.stopping=False;self.child=None
  for path in self.root.glob('*/state.json'):
   value=json.loads(path.read_text())
   if value['state']=='running': value['state']='outcome_unknown';value['detail']='Worker restarted; recover the original result';atomic(path,value)
 def describe(self):
  if self.capability: return self.capability()
  lock=ROOT/'workers/video/model-lock.json'; models=pathlib.Path(os.environ.get('DREAMER_MODEL_MANIFEST', str(ROOT/'.local/video-models.json')))
  ready=False; assets=[]
  if models.exists():
   try:
    assets=json.loads(models.read_text()); ready=bool(assets) and all(pathlib.Path(a['path']).is_file() and pathlib.Path(a['path']).stat().st_size==a['size'] for a in assets)
   except (ValueError,OSError): pass
  versions={name:importlib.metadata.version(name) for name in ['torch','transformers','diffusers','ltx-video']}
  identity={'profiles':PROFILES,'versions':versions,'hardware':self.hardware,'modelLock':lock.read_text() if lock.exists() else '',
   'runner':hashlib.sha256(self.runner.read_bytes()+(ROOT/'workers/video/model_assets.py').read_bytes()+(ROOT/'workers/video/reference_assets.py').read_bytes()).hexdigest(),
   'files':[(a['sha256'],pathlib.Path(a['path']).stat().st_mtime_ns if pathlib.Path(a['path']).exists() else None) for a in assets]}
  fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
  return {'id':'ltx-video','available':ready and self.hardware['mpsAvailable'],'fingerprint':fingerprint,'profile':PROFILE,'profiles':list(PROFILES),
   'detail':'Apple GPU 不可用，未启用 CPU 回退' if not self.hardware['mpsAvailable'] else '本机 LTX 2B 已配置；须真实检测与动作审阅' if ready else '模型文件尚未下载并完成哈希校验',
   'executionLocation':'local','inferenceLocation':'local','dataEgress':'none','width':288,'height':512,'frames':49,'fps':16}
 def directory(self,id):
  if str(uuid.UUID(id))!=id: raise ValueError('Invalid ID')
  return self.root/id
 def get(self,id):
  path=self.directory(id)/'state.json'
  if not path.exists(): return None
  state=json.loads(path.read_text()); result=path.parent/'result.json'
  if state['state'] in ['running','outcome_unknown'] and result.exists():
   receipt=json.loads(result.read_text()); request=json.loads((path.parent/'request.json').read_text())
   if receipt.get('requestId')!=id or receipt.get('fingerprint')!=request['fingerprint']: raise ValueError('Result identity mismatch')
   state.update(receipt); state['finishedAt']=time.time();atomic(path,state)
  # After a Worker crash, never kill a PID that might have been reused.
  # An inherited flock remains held by the owned runner/server until they exit.
  if state['state']=='outcome_unknown' and state.get('cancelRequested'):
   with open(self.gpu_lock.name,'a') as probe:
    try: fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: pass
    else:
     state.update(state='cancelled',detail='原执行进程已释放 GPU 锁；取消已确认',finishedAt=time.time());atomic(path,state)
     fcntl.flock(probe,fcntl.LOCK_UN)
  return state
 def submit(self,value):
  request=self.validator(value);id=request['requestId'];directory=self.directory(id)
  with self.guard:
   if (directory/'request.json').exists():
    if json.loads((directory/'request.json').read_text())!=request: raise ValueError('Idempotency conflict')
    return self.get(id)
   cap=self.describe()
   if not cap['available'] or cap['fingerprint']!=request['fingerprint']: raise ValueError('Capability not ready or changed')
   if any(self.get(path.parent.name)['state'] in ['queued','running','outcome_unknown'] for path in self.root.glob('*/state.json')): raise ValueError('GPU slot occupied')
   # Validate before registration; stage immutable reference bytes in the job, never silently fall back to T2V.
   import tempfile, shutil
   with tempfile.TemporaryDirectory(dir=self.root,prefix='stage-') as staging:
    self.snapshot(request,self.root,staging)
    directory.mkdir(mode=0o700)
    if (pathlib.Path(staging)/'references').exists(): shutil.move(str(pathlib.Path(staging)/'references'),directory/'references')
    atomic(directory/'request.json',request)
   state={'requestId':id,'state':'queued','detail':'等待本机 GPU','createdAt':time.time()};atomic(directory/'state.json',state);return state
 def cancel(self,id):
  with self.guard:
   state=self.get(id)
   if state is None: raise ValueError('Missing request')
   state['cancelRequested']=True
   if state['state']=='queued': state['state']='cancelled'
   atomic(self.directory(id)/'state.json',state);return self.get(id)
 def tick(self):
  try: fcntl.flock(self.gpu_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: return
  try: self.execute_next()
  finally: fcntl.flock(self.gpu_lock,fcntl.LOCK_UN)
 def execute_next(self):
  with self.guard:
   all_states=[self.get(path.parent.name) for path in self.root.glob('*/state.json')]
   if any(s['state'] in ['running','outcome_unknown'] for s in all_states): return
   state=next((s for s in all_states if s['state']=='queued'),None)
   if not state: return
   directory=self.directory(state['requestId']);request=json.loads((directory/'request.json').read_text());cap=self.describe()
   if request['fingerprint']!=cap['fingerprint'] or not cap['available']:
    state.update(state='failed',detail='模型或运行环境变化，需要重新检测');atomic(directory/'state.json',state);return
   state.update(state='running',startedAt=time.time(),detail='本机模型推理中');atomic(directory/'state.json',state)
  with (directory/'worker.log').open('w') as log:
   try:self.child=subprocess.Popen([sys.executable,str(self.runner),str(directory)],stdout=log,stderr=log,cwd=ROOT,start_new_session=True,pass_fds=(self.gpu_lock.fileno(),),env={**os.environ,'DREAMER_GPU_LOCK_FD':str(self.gpu_lock.fileno()),'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1'})
   except OSError:
    with self.guard:state.update(state='failed',detail='推理进程未能启动');atomic(directory/'state.json',state)
    return
   cancelled=False
   while self.child.poll() is None:
    time.sleep(.25)
    with self.guard: latest=json.loads((directory/'state.json').read_text())
    if self.stopping or latest.get('cancelRequested') or time.time()-state['startedAt']>self.timeout:
     cancelled=True;os.killpg(self.child.pid,signal.SIGTERM)
     try:self.child.wait(timeout=5)
     except subprocess.TimeoutExpired:os.killpg(self.child.pid,signal.SIGKILL);self.child.wait()
     break
   # A runner can crash while its MLX server survives. Reap the owned process
   # group before releasing the GPU flock, even on a normal-looking runner exit.
   try:
    os.killpg(self.child.pid,signal.SIGTERM)
    time.sleep(.2)
    os.killpg(self.child.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   with self.guard:
    current=self.get(state['requestId'])
    if cancelled: current.update(state='cancelled',detail='执行已停止；迟到产物不进入预览')
    elif current['state']=='running': current.update(state='failed',detail='推理进程已退出但没有完整回执')
    current['finishedAt']=time.time();atomic(directory/'state.json',current)
   self.child=None
 def loop(self):
  while not self.stopping:
   try:self.tick()
   except Exception as error: print(type(error).__name__,flush=True)
   time.sleep(.25)
 def heartbeat(self):
  while not self.stopping:
   try:atomic(self.root/'descriptor.json',{**self.describe(),'lastHeartbeatAt':time.time()})
   except Exception:pass
   time.sleep(2)
 def close(self): self.stopping=True
class Handler(BaseHTTPRequestHandler):
 server_version='DreamerVideoWorker'
 def log_message(self,*args): pass
 def handle_request(self):
  engine=self.server.engine
  if self.headers.get('Origin') or self.headers.get('Host')!=f'127.0.0.1:{self.server.server_port}' or not hmac.compare_digest(self.headers.get('Authorization',''),f'Bearer {engine.token}'):
   self.send_error(403);return
  try:
   path=self.path.split('?')[0].strip('/').split('/')
   with engine.guard:
    if self.command=='GET' and path==['health']: value=engine.describe()
    elif self.command=='GET' and len(path)==2 and path[0]=='jobs': value=engine.get(path[1])
    elif self.command=='POST' and path==['jobs']:
     size=int(self.headers.get('Content-Length','0'))
     if not 0<size<=16000: raise ValueError('Request size invalid')
     value=engine.submit(json.loads(self.rfile.read(size)))
    elif self.command=='POST' and len(path)==3 and path[0]=='jobs' and path[2]=='cancel': value=engine.cancel(path[1])
    else:self.send_error(404);return
   data=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
  except (ValueError,KeyError,TypeError): self.send_error(409,'Invalid request or worker state')
 do_GET=handle_request;do_POST=handle_request
if __name__=='__main__':
 engine=Engine(pathlib.Path(os.environ.get('DREAMER_VIDEO_DATA', str(ROOT/'.local/video-worker'))));server=ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('DREAMER_VIDEO_PORT','4328'))),Handler);server.engine=engine
 inference_thread=threading.Thread(target=engine.loop);inference_thread.start()
 threading.Thread(target=engine.heartbeat,daemon=True).start()
 def stop(*_): engine.close();threading.Thread(target=server.shutdown,daemon=True).start()
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 print('Video worker listening on loopback port 4328',flush=True)
 try:server.serve_forever()
 finally:engine.close();inference_thread.join();server.server_close()
