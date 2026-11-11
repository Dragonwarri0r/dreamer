import {existsSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'smol-toml';
import {DomainError} from '../../contracts/foundation.ts';

export type AgentModelOptions={model?:string;reasoningEffort?:string};
type ConfigSource='options'|'environment'|'codex-config'|'provider-default';
export type AgentModelConfig=AgentModelOptions&{sources:{model:ConfigSource;reasoningEffort:ConfigSource}};

/** Inherit only these two top-level preferences, never providers, plugins, permissions or credentials. */
export function resolveAgentModelConfig(options:AgentModelOptions={},env:NodeJS.ProcessEnv=process.env,sourceHome:string|null=env.CODEX_HOME??join(homedir(),'.codex')):AgentModelConfig{
 const direct={model:options.model??env.DREAMER_AGENT_MODEL,reasoningEffort:options.reasoningEffort??env.DREAMER_AGENT_REASONING_EFFORT};
 let inherited:Record<string,unknown>={};
 if(sourceHome!==null&&(direct.model===undefined||direct.reasoningEffort===undefined)){
  const path=join(sourceHome,'config.toml');
  if(existsSync(path)){
   try{const config=parse(readFileSync(path,'utf8'));inherited={model:config.model,reasoningEffort:config.model_reasoning_effort};}
   catch{throw new DomainError('VALIDATION','无法读取 Codex 模型配置；请检查 config.toml，或显式设置模型与推理强度');}
  }
 }
 const values:AgentModelOptions={},sources:AgentModelConfig['sources']={model:'provider-default',reasoningEffort:'provider-default'};
 for(const key of ['model','reasoningEffort'] as const){
  const raw=direct[key]??inherited[key];
  if(raw===undefined)continue;
  // The protocol accepts extensible model/effort names; account support is confirmed by App Server.
  if(typeof raw!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(raw.trim()))throw new DomainError('VALIDATION',`Codex ${key==='model'?'模型':'推理强度'}必须是非空名称`);
  values[key]=raw.trim();
  sources[key]=options[key]!==undefined?'options':direct[key]!==undefined?'environment':'codex-config';
 }
 return {...values,sources};
}
