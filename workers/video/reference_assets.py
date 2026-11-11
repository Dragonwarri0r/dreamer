"""Content-addressed PNG conditioning, snapshotted per job. No client-supplied paths."""
import hashlib, pathlib, re, shutil
PROFILES={'ltx-mps-sample/v1':49,'ltx-mps-i2v/v1':49,'ltx-mps-i2v-story/v1':129}
def validate_references(request):
 refs=request.get('references',[]);frames=PROFILES[request['profile']]
 if request['profile']=='ltx-mps-sample/v1':
  if refs: raise ValueError('T2V cannot silently consume image references')
  return []
 if not isinstance(refs,list) or not 1<=len(refs)<=2: raise ValueError('I2V requires a start reference')
 for index,ref in enumerate(refs):
  if not isinstance(ref,dict) or set(ref)!={'sha256','frame'}: raise ValueError('Invalid reference fields')
  if not isinstance(ref['sha256'],str) or not re.fullmatch('[a-f0-9]{64}',ref['sha256']): raise ValueError('Invalid reference hash')
  if type(ref['frame']) is not int or ref['frame']!=([0,frames-1][index]): raise ValueError('Only first and optional last frame conditioning is supported')
 return refs
def check_png(path,digest):
 from PIL import Image
 if path.is_symlink() or not path.is_file() or not 1<=path.stat().st_size<=10*1024*1024: raise ValueError('Invalid reference file')
 if hashlib.sha256(path.read_bytes()).hexdigest()!=digest: raise ValueError('Reference hash mismatch')
 with Image.open(path) as image:
  if image.format!='PNG' or getattr(image,'n_frames',1)!=1 or not 64<=image.width<=4096 or not 64<=image.height<=4096: raise ValueError('Reference must be a bounded still PNG')
  image.verify()
def snapshot_references(request,root,destination):
 refs=validate_references(request)
 for index,ref in enumerate(refs):
  source=pathlib.Path(root)/'references'/(ref['sha256']+'.png');check_png(source,ref['sha256'])
  if source.parent.is_symlink(): raise ValueError('Reference directory cannot be a symlink')
 if refs:
  target=pathlib.Path(destination)/'references';target.mkdir(mode=0o700)
  for index,ref in enumerate(refs):
   path=target/(str(index)+'.png');shutil.copyfile(pathlib.Path(root)/'references'/(ref['sha256']+'.png'),path);path.chmod(0o600);check_png(path,ref['sha256'])
def job_reference_paths(request,job):
 refs=validate_references(request);paths=[]
 for index,ref in enumerate(refs):
  path=pathlib.Path(job)/'references'/(str(index)+'.png');check_png(path,ref['sha256']);paths.append(path)
 return paths
