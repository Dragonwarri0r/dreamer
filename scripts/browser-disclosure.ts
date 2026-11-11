import type {Page} from 'playwright';
/** Follow the visible disclosure entry point, without bypassing the UI. */
export async function openDisclosure(page:Page,title:string){
 const summary=page.locator('summary').filter({hasText:new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`)}).first();
 await summary.waitFor();
 if(!await summary.evaluate(element=>(element.parentElement as HTMLDetailsElement).open))await summary.click();
}
