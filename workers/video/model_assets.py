"""Restore upstream filenames without duplicating immutable cached assets."""
import pathlib

def materialize_assets(assets,destination):
 directory=pathlib.Path(destination);directory.mkdir(parents=True,exist_ok=True)
 required={'tokenizer/added_tokens.json','tokenizer/special_tokens_map.json','tokenizer/spiece.model','tokenizer/tokenizer_config.json',
  'text_encoder/config.json','t5xxl_fp16.safetensors','ltxv-2b-0.9.6-distilled-04-25.safetensors'}
 entries={a['file']:a for a in assets}
 if not required.issubset(entries): raise ValueError('Tokenizer files are incomplete')
 for name in sorted(required):
  source=pathlib.Path(entries[name]['path']).resolve(strict=True);target=directory/name
  target.parent.mkdir(parents=True,exist_ok=True)
  if target.is_symlink() and target.resolve()==source: continue
  if target.exists() or target.is_symlink(): raise ValueError('Model asset path conflict')
  target.symlink_to(source)
 return directory
