/** Keep the changed range and nearby context; never clip changed text. */
export function textDiffContext(before:string,after:string,context=90){
 let prefix=0,suffix=0;
 while(prefix<Math.min(before.length,after.length)&&before[prefix]===after[prefix])prefix++;
 while(suffix<Math.min(before.length-prefix,after.length-prefix)&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
 const head=Math.max(0,prefix-context),tail=Math.max(0,suffix-context);
 return {head,tail,before:before.slice(head,before.length-tail),after:after.slice(head,after.length-tail)};
}
