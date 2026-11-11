/** SRT line breaking independent of libass' optional Unicode line-break library. */
export function subtitleStyle(width:number,height:number){
 const fontSize=Math.max(12,Math.round(Math.min(width,height)/22));
 const margin=Math.max(4,Math.round(width*.05));
 return {fontSize,margin,vertical:Math.max(4,Math.round(height*.055)),columns:Math.max(2,Math.floor((width-2*margin)/fontSize)-1)};
}
export function wrapSubtitle(text:string,columns:number){
 const segmenter=new Intl.Segmenter('zh',{granularity:'grapheme'});
 return text.replaceAll('\r','').split('\n').map(line=>{
  const chars=[...segmenter.segment(line)].map(s=>s.segment),lines:string[]=[];
  while(chars.length>columns){
   let end=columns;
   // Prefer a nearby word boundary; long words still wrap inside the safe width.
   for(let i=columns-1;i>=Math.floor(columns*.6);i--)if(/\s/u.test(chars[i])){end=i+1;break;}
   // Keep a closing punctuation mark with the preceding word where possible.
   if(/^[，。！？；：、,.!?;:）】”’]$/u.test(chars[end]??'')&&end>1)end--;
   lines.push(chars.splice(0,end).join('').trimEnd());
   while(chars[0]&&/^\s$/u.test(chars[0]))chars.shift();
  }
  lines.push(chars.join(''));return lines.join('\n');
 }).join('\n');
}
