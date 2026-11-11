import type {Page} from 'playwright';

/** Follow the visible secondary entry instead of bypassing collapsed UI. */
export async function openExperienceTools(page:Page){
 const trigger=page.getByRole('button',{name:/^(更多体验操作|管理档案)$/});
 await trigger.waitFor();if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
}
export async function experienceAction(page:Page,name:string){
 await openExperienceTools(page);await page.getByRole('button',{name,exact:true}).click();
}
export async function experienceProfile(page:Page){
 await openExperienceTools(page);await page.getByLabel('当前体验 UID',{exact:true}).waitFor();
}
export async function experienceUid(page:Page){
 await experienceProfile(page);const uid=await page.getByLabel('当前体验 UID',{exact:true}).inputValue();await page.keyboard.press('Escape');return uid;
}
export async function preparationAction(page:Page,name:string){
 const section=page.locator('.experience-preparation-options');await section.waitFor();if(await section.getAttribute('open')===null)await section.locator('summary').click();
 await section.getByRole('button',{name,exact:true}).click();
}
