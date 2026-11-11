"""One bounded LTX inference. No network, optional code, prompt enhancer or fallback renderer."""
import gc, hashlib, json, os, pathlib, resource, sys, threading, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
os.environ['HF_HUB_OFFLINE']='1'; os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ['HF_HOME']=str(ROOT/'.local/hf')
os.environ['TOKENIZERS_PARALLELISM']='false'
job=pathlib.Path(sys.argv[1]).resolve(); request=json.loads((job/'request.json').read_text())
started=time.monotonic();stage_started=started;current_stage='imports';timings={};memory_samples=[]
peak={'mpsAllocatedBytes':0,'mpsDriverBytes':0};sampling_done=threading.Event();sampler=None
def stage(message):
 global stage_started,current_stage
 now=time.monotonic();timings[current_stage]=round(now-stage_started,3);stage_started=now;current_stage=message
 print(json.dumps({'stage':message,'elapsedSeconds':round(now-started,3)}),flush=True)
def finish(value):
 sampling_done.set()
 if sampler is not None: sampler.join()
 timings[current_stage]=round(time.monotonic()-stage_started,3)
 value['performance']={'peakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'sampledPeakGpu':peak,
  'stageSeconds':timings,'memorySamplingIntervalMs':200}
 (job/'memory-samples.json').write_text(json.dumps(memory_samples))
 temp=job/'result.tmp';temp.write_text(json.dumps(value));temp.replace(job/'result.json')
try:
 import torch
 import imageio.v2 as imageio
 import numpy as np
 import psutil
 from safetensors import safe_open
 from transformers import T5EncoderModel,T5Config,T5Tokenizer
 from ltx_video.models.autoencoders.causal_video_autoencoder import CausalVideoAutoencoder
 from ltx_video.models.transformers.transformer3d import Transformer3DModel
 from ltx_video.models.transformers.symmetric_patchifier import SymmetricPatchifier
 from ltx_video.schedulers.rf import RectifiedFlowScheduler
 from ltx_video.pipelines.pipeline_ltx_video import LTXVideoPipeline, ConditioningItem
 from ltx_video.inference import load_image_to_tensor_with_resize_and_crop
 from ltx_video.utils.skip_layer_strategy import SkipLayerStrategy
 from model_assets import materialize_assets
 from reference_assets import PROFILES, job_reference_paths
 reference_paths=job_reference_paths(request,job);frame_count=PROFILES[request['profile']]
 if not torch.backends.mps.is_available(): raise RuntimeError('MPS GPU is unavailable; CPU fallback is disabled')
 torch.mps.set_per_process_memory_fraction(0.60)
 process=psutil.Process()
 def sample_memory():
  while not sampling_done.wait(.2):
   allocated=torch.mps.current_allocated_memory();driver=torch.mps.driver_allocated_memory()
   peak['mpsAllocatedBytes']=max(peak['mpsAllocatedBytes'],allocated)
   peak['mpsDriverBytes']=max(peak['mpsDriverBytes'],driver)
   memory_samples.append({'elapsedSeconds':round(time.monotonic()-started,3),'stage':current_stage,'mpsAllocatedBytes':allocated,'mpsDriverBytes':driver,'rssBytes':process.memory_info().rss,'peakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
 sampler=threading.Thread(target=sample_memory,daemon=True);sampler.start()
 assets=json.loads(pathlib.Path(os.environ.get('DREAMER_MODEL_MANIFEST', str(ROOT/'.local/video-models.json'))).read_text())
 model_dir=materialize_assets(assets,job/'models')
 def asset(name): return model_dir/name
 stage('loading_text_encoder')
 tokenizer=T5Tokenizer.from_pretrained(str(model_dir/'tokenizer'),local_files_only=True)
 config=T5Config.from_json_file(str(asset('text_encoder/config.json')))
 with torch.device('meta'): encoder=T5EncoderModel(config)
 with safe_open(asset('t5xxl_fp16.safetensors'),framework='pt',device='cpu') as weights:
  state={k:weights.get_tensor(k) for k in weights.keys()}
 if 'shared.weight' not in state: state['shared.weight']=state['encoder.embed_tokens.weight']
 if 'encoder.embed_tokens.weight' not in state: state['encoder.embed_tokens.weight']=state['shared.weight']
 encoder.load_state_dict(state,strict=True,assign=True);del state
 encoder=encoder.to(dtype=torch.bfloat16,device='mps').eval()
 tokens=tokenizer(request['prompt'],padding='max_length',max_length=256,truncation=True,return_tensors='pt')
 stage('encoding_prompt')
 with torch.inference_mode(): embeds=encoder(input_ids=tokens.input_ids.to('mps'),attention_mask=tokens.attention_mask.to('mps'))[0].cpu()
 if not torch.isfinite(embeds).all(): raise RuntimeError('Text encoder returned non-finite embeddings')
 del encoder;gc.collect();torch.mps.empty_cache()
 stage('loading_video_model')
 checkpoint=asset('ltxv-2b-0.9.6-distilled-04-25.safetensors')
 vae=CausalVideoAutoencoder.from_pretrained(checkpoint,torch_dtype=torch.bfloat16).to(device='mps').eval()
 transformer=Transformer3DModel.from_pretrained(checkpoint).to(dtype=torch.bfloat16,device='mps').eval()
 scheduler=RectifiedFlowScheduler.from_pretrained(checkpoint)
 with safe_open(checkpoint,framework='pt') as weights: allowed=json.loads(weights.metadata()['config']).get('allowed_inference_steps')
 pipeline=LTXVideoPipeline(transformer=transformer,patchifier=SymmetricPatchifier(patch_size=1),text_encoder=None,tokenizer=tokenizer,
  scheduler=scheduler,vae=vae,allowed_inference_steps=allowed,prompt_enhancer_image_caption_model=None,
  prompt_enhancer_image_caption_processor=None,prompt_enhancer_llm_model=None,prompt_enhancer_llm_tokenizer=None)
 pipeline=pipeline.to('mps')
 conditioning=[ConditioningItem(load_image_to_tensor_with_resize_and_crop(str(path),512,288),ref['frame'],1.0) for path,ref in zip(reference_paths,request.get('references',[]))]
 torch.mps.synchronize()
 stage('generating_motion')
 torch.mps.manual_seed(request['seed'])
 def on_step_end(_pipeline,step,_timestep,_values):
  if step==7:
   torch.mps.synchronize();stage('decoding_video')
 with torch.inference_mode():
  frames=pipeline(prompt=None,negative_prompt=None,prompt_embeds=embeds,prompt_attention_mask=tokens.attention_mask.to('mps'),
   negative_prompt_embeds=torch.zeros_like(embeds),negative_prompt_attention_mask=torch.zeros_like(tokens.attention_mask).to('mps'),
   height=512,width=288,num_frames=frame_count,frame_rate=16,num_inference_steps=8,guidance_scale=1,stg_scale=0,rescaling_scale=1,
   decode_timestep=0.05,decode_noise_scale=0.025,skip_layer_strategy=SkipLayerStrategy.AttentionValues,
   generator=torch.Generator(device='mps').manual_seed(request['seed']),output_type='pt',is_video=True,
   vae_per_channel_normalize=True,image_cond_noise_scale=0,mixed_precision=False,offload_to_cpu=False,
   device='mps',enhance_prompt=False,stochastic_sampling=True,callback_on_step_end=on_step_end,conditioning_items=conditioning or None).images
  if not torch.isfinite(frames).all(): raise RuntimeError('Video model returned non-finite pixels')
  pixels=(frames[0].permute(1,2,3,0).cpu().float().numpy()*255).clip(0,255).astype(np.uint8)
 stage('encoding_mp4')
 imageio.mimwrite(job/'output.mp4',pixels,fps=16,codec='libx264',macro_block_size=1,ffmpeg_params=['-pix_fmt','yuv420p','-movflags','+faststart'])
 with (job/'output.mp4').open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
 finish({'state':'completed','requestId':request['requestId'],'fingerprint':request['fingerprint'],'outputSha256':digest,
  'source':'video-model','modelId':'LTX-Video-2B-0.9.6-distilled','profile':request['profile'],'references':request.get('references',[]),'referencePreprocessing':'upstream-center-crop-resize-blur-crf-v1' if conditioning else None,'width':288,'height':512,'frames':frame_count,'fps':16,
  'elapsedSeconds':round(time.monotonic()-started,2),'motionReviewed':False})
 print('completed',flush=True)
except Exception as error:
 import traceback;traceback.print_exc()
 finish({'state':'failed','requestId':request['requestId'],'fingerprint':request['fingerprint'],'detail':'Local inference failed; see the private worker log','errorType':type(error).__name__,'elapsedSeconds':round(time.monotonic()-started,2)})
 sys.exit(1)
