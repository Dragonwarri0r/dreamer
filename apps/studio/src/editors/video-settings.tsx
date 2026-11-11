import React,{useEffect,useState} from 'react';
import {api} from '../client.ts';
import {registerEditor,type EditorProps} from '../editors.tsx';
import {cloudVideoDefinitions,wanRegions,type CloudVideoPublicSettings} from '../../../../packages/contracts/cloud-video.ts';

function ProviderSettings({value,onSaved}:{value:CloudVideoPublicSettings;onSaved:()=>Promise<void>}){
 const [form,setForm]=useState(value),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const d=cloudVideoDefinitions[value.id];
 useEffect(()=>setForm(value),[JSON.stringify(value)]);
 async function save(check=false,clearKey=false){
  setBusy(true);setMessage('');try{
   const {id,enabled,model,workspace,region}=form;
   const saved=await api.saveVideoSettings({id,enabled:clearKey?false:enabled,model,workspace,region,apiKey:clearKey?undefined:key||undefined,clearKey});
   setKey('');setForm(saved);await onSaved();
   setMessage(check?(await api.checkVideoSettings(id)).message:clearKey?'Key 已移除，Provider 已停用。':'已保存。可以在「生成与素材」中选择此模型。');
  }catch(e:any){setMessage(e.message);}finally{setBusy(false);}
 }
 return <form className="provider-settings-card" onSubmit={e=>{e.preventDefault();void save();}}>
  <div className="actions"><h2>{d.title}</h2><span className="badge">{value.configured?'Key 已保存':'等待填写 Key'}</span></div>
  <div className="actions"><a className="button" href={d.keyUrl} target="_blank" rel="noreferrer">申请 / 管理 Key ↗</a><a href={d.docsUrl} target="_blank" rel="noreferrer">官方接入文档 ↗</a></div>
  <label className="checkbox"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>启用 {d.title}</label>
  <label>API Key<input aria-label={`${value.id} API Key`} type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)} placeholder={value.configured?'留空保留已保存的 Key':'粘贴平台 API Key'}/></label>
  {value.id==='wan'?<>
   <div className="form-grid"><label>所属地域<select aria-label="万相地域" value={form.region} onChange={e=>setForm({...form,region:e.target.value as typeof form.region})}>{wanRegions.map(r=><option key={r}>{r}</option>)}</select></label>
   <label>工作空间 ID<input aria-label="万相工作空间 ID" value={form.workspace} onChange={e=>setForm({...form,workspace:e.target.value})} placeholder="从阿里云工作空间复制 ID"/></label></div>
   <label>模型<select aria-label="wan 模型" value={form.model} onChange={e=>setForm({...form,model:e.target.value})}><option value="wan3.0-video">万相 3.0 标准版</option><option value="wan3.0-video-prime">万相 3.0 加速版</option></select></label>
   <p className="muted">Key、工作空间与地域必须匹配。按官方新版接口使用工作空间专属域名。</p>
  </>:value.id==='seedance'?<label>模型 ID / 推理接入点 ID<input aria-label="seedance 模型" value={form.model} onChange={e=>setForm({...form,model:e.target.value})}/></label>:<p className="muted">接入 fal 的 H3 Max，支持原生音画和首尾帧。768p 标价 $0.08/秒，5 秒约 $0.40；按平台当前账单为准。</p>}
  {value.id==='fal-h3'&&<p className="muted"><a href="https://fal.ai/minimax-h3-max" target="_blank" rel="noreferrer">先在网页免费试效果 ↗</a> · 官方说明每天 5 次免费生成仅在 Sandbox，API 另计费。Turbo 更便宜，当前接入使用 H3 Max 标准版。</p>}
  <details><summary>已保存的接口地址</summary><code className="provider-endpoint">{value.endpoint||'填写工作空间并保存后显示'}</code></details>
  <div className="actions"><button className="primary" disabled={busy}>保存配置</button><button type="button" disabled={busy||!form.enabled||(!key&&!value.configured)} onClick={()=>void save(true)}>保存并检查接口</button>{value.configured&&<button type="button" disabled={busy} onClick={()=>void save(false,true)}>移除 Key</button>}</div>
  {message&&<p className="provider-message" role="status">{message}</p>}
 </form>;
}
function VideoSettings({ctx}:EditorProps){
 const [values,setValues]=useState<CloudVideoPublicSettings[]>([]),[error,setError]=useState('');
 async function load(){setValues(await api.videoSettings());}
 useEffect(()=>{load().catch(e=>setError(e.message));},[]);
 return <div className="editor-scroll video-settings"><div className="eyebrow">视频服务</div><h1>视频 API 设置</h1>
  <p>填入 Key 后即可选择云端模型生成原生音画。设置对这台工作台的所有项目生效，保存后立即可用。</p>
  <p className="muted">Key 只保存在本机服务的数据目录中，不回显、不进入 Agent 上下文或项目备份。「检查接口」只查询任务，不生成视频；余额、模型权限与效果需真实生成确认。</p>
  <div className="actions"><button onClick={()=>ctx.open('production','生成与素材')}>前往生成与素材</button><button onClick={()=>load().catch(e=>setError(e.message))}>刷新配置</button></div>
  {error&&<p role="alert">{error}</p>}{values.map(value=><ProviderSettings key={value.id} value={value} onSaved={async()=>{await load();await ctx.refresh();}}/>)}
 </div>;
}
registerEditor('video-settings',{title:'视频 API 设置',render:p=><VideoSettings {...p}/>});
