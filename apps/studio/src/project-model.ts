/** Derived project readiness; never substitutes view counts for content approval. */
export function projectProgress(state:any){
 const scenes=state.scenes??[],resources=state.resources??[],shots=(state.shots??[]).filter((s:any)=>!s.data.archived),builds=state.builds??[];
 const pictured=shots.filter((s:any)=>s.data.adoptedTakeId||s.data.panels.some((p:any)=>p.artifact));
 const pendingChanges=(state.changes??[]).filter((c:any)=>['proposed','approved','partial'].includes(c.data.state));
 return {
  scenes:scenes.length,resources:resources.length,published:resources.filter((r:any)=>r.publishedRef).length,
  shots:shots.length,pictured:pictured.length,missingPictures:shots.length-pictured.length,
  orphanShots:shots.filter((s:any)=>!s.data.scene).length,
  running:(state.jobs??[]).filter((j:any)=>['running','queued','collecting'].includes(j.data.state)),
  needsAttention:(state.jobs??[]).filter((j:any)=>['failed','unknown'].includes(j.data.state)),
  pendingChanges,builds:builds.filter((b:any)=>b.data.output),latestBuild:[...builds].reverse().find((b:any)=>b.data.output),
  next:!scenes.length?'story':!shots.length?'board':pictured.length<shots.length?'production':!builds.some((b:any)=>b.data.output)?'timeline':'review',
 };
}
