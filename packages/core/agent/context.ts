/** Character windows are UTF-16 offsets, matching human textarea selections. */
export function contentWindow(row:any,offset=0,limit=12000){
  const field=row.data.body!==undefined?'body':row.data.text!==undefined?'text':undefined;
  if(field){
    const text=row.data[field] as string;offset=Math.min(offset,text.length);const end=Math.min(text.length,offset+limit);
    return {...row,data:{...row.data,[field]:text.slice(offset,end)},contentPage:{field,offset,end,total:text.length,nextOffset:end<text.length?end:null,partial:offset>0||end<text.length}};
  }
  if(Array.isArray(row.data.blocks)){
    let position=0;const ranges:any[]=[];
    const blocks=row.data.blocks.flatMap((b:any)=>{
      const start=position;position+=b.text.length+1;
      if(position<=offset||start>=offset+limit)return [];
      const from=Math.max(0,offset-start),to=Math.min(b.text.length,offset+limit-start);
      ranges.push({blockId:b.id,from,to,total:b.text.length});return [{...b,text:b.text.slice(from,to)}];
    });
    const end=Math.min(position,offset+limit);
    return {...row,data:{...row.data,blocks},contentPage:{field:'blocks',offset,end,total:position,nextOffset:end<position?end:null,partial:offset>0||end<position,ranges}};
  }
  return row;
}
