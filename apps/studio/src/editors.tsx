import {ProjectOverview} from './project-overview.tsx';
import React from 'react';
import type { Tab } from './workbench.ts';
export type StudioContext={state:any;projectId:string;refresh:()=>Promise<void>;command:(operation:string,payload:unknown)=>Promise<any>;open:(type:string,title:string,objectId?:string,options?:{beside?:boolean;binding?:string})=>void;notify:(message:string)=>void;updateTab:(instanceId:string,patch:Partial<Pick<Tab,'objectId'|'binding'|'title'>>)=>void};
export type EditorProps={tab:Tab;ctx:StudioContext};
export type EditorDefinition={title:string;render:(props:EditorProps)=>React.ReactNode};
export const editors=new Map<string,EditorDefinition>();
export function registerEditor(type:string,definition:EditorDefinition){editors.set(type,definition);}
registerEditor('overview',{title:'项目工程',render:p=><ProjectOverview {...p}/>});
