"""Pinned H3 assets; reuse Short Dreamer files read-only, keep receipts in Dreamer."""
import hashlib, json, os, pathlib, platform, re, shutil, tarfile, uuid
from memory_policy import memory_policy
ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT.parent / 'short-dreamer'
MODEL_REVISION = '9c9273578ed5c2daf0b9a42eace823a6a49050ba'
RUNTIME_REVISION = 'ccedc6a4820f48e576633062232ed0cba1139616'
MODEL = pathlib.Path(os.environ.get('DREAMER_H3_MODEL', SOURCE/'.local/h3-models/MiniMax-H3-FL2VA-MLX-Serve-4bit')).resolve()
RUNTIME = pathlib.Path(os.environ.get('DREAMER_H3_RUNTIME', SOURCE/'.local/h3-runtime/v26.10.2/mlx-serve-macos-arm64/mlx-serve')).resolve()
MANIFEST = pathlib.Path(os.environ.get('DREAMER_H3_MANIFEST', ROOT/'.local/h3-assets.json'))
PROFILES = json.loads((ROOT/'packages/contracts/h3-profiles.json').read_text())

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4*1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def verify_assets():
    evidence = json.loads((SOURCE/'test-results/h3-local-trial-20261019/download.json').read_text())
    if not evidence.get('complete') or evidence['revision'] != MODEL_REVISION:
        raise ValueError('Pinned download evidence is missing')
    files = []
    for name, record in evidence['files'].items():
        if name.endswith('.tar.gz'): continue
        path = MODEL/name
        if path.stat().st_size != record['expectedBytes']: raise ValueError(f'Size mismatch: {name}')
        actual = digest(path)
        expected = record['hash']
        if len(expected) == 40:
            blob = path.read_bytes()
            check = hashlib.sha1(f'blob {len(blob)}\0'.encode()+blob).hexdigest()
        else: check = actual
        if check != expected: raise ValueError(f'Hash mismatch: {name}')
        files.append({'path':str(path),'size':path.stat().st_size,'mtime':path.stat().st_mtime_ns,'sha256':actual})
    archive=RUNTIME.parent.parent/'mlx-serve-bin-macos-arm64.tar.gz'
    if digest(archive)!=evidence['files'][archive.name]['hash']: raise ValueError('Runtime archive hash mismatch')
    shipped={}
    with tarfile.open(archive,'r:gz') as tar:
        for member in tar:
            if member.isfile():
                stream=tar.extractfile(member);h=hashlib.sha256()
                for chunk in iter(lambda:stream.read(4*1024*1024),b''):h.update(chunk)
                shipped[member.name.removeprefix('./')]=h.hexdigest()
    # Verify extracted code/libraries against the pinned archive without extracting over them.
    for path in sorted(RUNTIME.parent.rglob('*')):
        if path.is_file():
            actual=digest(path);relative=str(path.relative_to(RUNTIME.parent.parent))
            if shipped.get(relative)!=actual: raise ValueError(f'Runtime file mismatch: {relative}')
            files.append({'path':str(path),'size':path.stat().st_size,'mtime':path.stat().st_mtime_ns,'sha256':actual})
    if not RUNTIME.is_file(): raise ValueError('Runtime missing')
    manifest = {'modelRevision':MODEL_REVISION,'runtimeRevision':RUNTIME_REVISION,'model':str(MODEL),'runtime':str(RUNTIME),'files':files}
    MANIFEST.parent.mkdir(parents=True,exist_ok=True)
    tmp=MANIFEST.with_suffix('.tmp');tmp.write_text(json.dumps(manifest,indent=2));tmp.chmod(0o600);tmp.replace(MANIFEST)
    return manifest

def describe():
    manifest={};ready=False
    try:
        manifest=json.loads(MANIFEST.read_text())
        ready=(manifest['modelRevision']==MODEL_REVISION and manifest['runtimeRevision']==RUNTIME_REVISION
               and manifest['model']==str(MODEL) and manifest['runtime']==str(RUNTIME) and bool(manifest['files'])
               and all(pathlib.Path(a['path']).stat().st_size==a['size'] and pathlib.Path(a['path']).stat().st_mtime_ns==a['mtime'] for a in manifest['files']))
    except (OSError,ValueError,KeyError): pass
    sources=[*pathlib.Path(__file__).parent.glob('*.py'),ROOT/'workers/video/worker.py',ROOT/'workers/video/reference_assets.py']
    fingerprint=hashlib.sha256(json.dumps({'manifest':manifest,'memoryPolicy':memory_policy(),'profiles':PROFILES,'sources':[digest(p) for p in sorted(sources)]},sort_keys=True).encode()).hexdigest()
    return {'id':'h3','available':ready and platform.system()=='Darwin' and platform.machine()=='arm64',
            'fingerprint':fingerprint,'profiles':list(PROFILES),'lastFrame':True,'audio':True,
            'detail':'H3 · 本地音画生成 · '+('允许系统压缩与 swap' if memory_policy()=='swap-friendly' else '严格内存预检')+' · 4 步预览 / 16 步候选' if ready else '请先运行 npm run h3:verify 校验本地 H3 资产'}

def validate_request(value):
    required={'requestId','fingerprint','profile','prompt','seed'}
    if not isinstance(value,dict) or not required<=set(value) or set(value)-required-{'references'}: raise ValueError('Unknown or missing fields')
    if str(uuid.UUID(value['requestId']))!=value['requestId']: raise ValueError('Invalid request ID')
    if value['profile'] not in PROFILES or not isinstance(value['fingerprint'],str): raise ValueError('Unsupported profile')
    if not isinstance(value['prompt'],str) or not value['prompt'].strip() or not 1<=len(value['prompt'])<=4000: raise ValueError('Non-empty visual/audio prompt required, at most 4000 Unicode characters')
    try: value['prompt'].encode('utf-8',errors='strict')
    except UnicodeEncodeError as error: raise ValueError('Prompt must contain valid Unicode') from error
    if type(value['seed']) is not int or not 0<=value['seed']<2**31: raise ValueError('Invalid seed')
    refs=value.get('references',[])
    if not isinstance(refs,list) or len(refs)>2: raise ValueError('At most first and last frames')
    for index,ref in enumerate(refs):
        if not isinstance(ref,dict) or set(ref)!={'sha256','frame'} or not isinstance(ref['sha256'],str) or not re.fullmatch('[a-f0-9]{64}',ref['sha256']): raise ValueError('Invalid reference hash')
        if type(ref['frame']) is not int or ref['frame'] != [0,123][index]: raise ValueError('Invalid reference frame')
    return value

def snapshot(request,root,destination):
    from reference_assets import check_png
    refs=validate_request(request).get('references',[])
    if not refs: return
    source=pathlib.Path(root)/'references'
    if source.is_symlink(): raise ValueError('Reference directory cannot be a symlink')
    target=pathlib.Path(destination)/'references';target.mkdir(mode=0o700)
    for i,ref in enumerate(refs):
        path=source/(ref['sha256']+'.png');check_png(path,ref['sha256'])
        output=target/f'{i}.png';shutil.copyfile(path,output);output.chmod(0o600);check_png(output,ref['sha256'])

if __name__=='__main__':
    print(json.dumps({'verifiedFiles':len(verify_assets()['files']),'manifest':str(MANIFEST)}))
