import fs from 'node:fs/promises';
import { expect, type ElectronApplication } from '@playwright/test';

export async function checkReadingSidebar(app: ElectronApplication) {
  const state = () => app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`(() => {
    const sidebar=document.getElementById('nw-settings-sidebar').getBoundingClientRect();
    const panel=document.getElementById('nw-project-persona').getBoundingClientRect();
    const handle=document.querySelector('.nw-resize-sidebar').getBoundingClientRect();
    return {width:sidebar.width,panelLeft:panel.left,x:handle.x+handle.width/2,y:handle.y+30};
  })()`));
  const before = await state();
  await app.evaluate(({ BrowserWindow }, position) => {
    const contents=BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents;
    const x=Math.round(position.x),y=Math.round(position.y);
    contents.sendInputEvent({type:'mouseMove',x,y});
    contents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
    contents.sendInputEvent({type:'mouseMove',x:x+60,y});
    contents.sendInputEvent({type:'mouseUp',x:x+60,y,button:'left',clickCount:1});
  }, before);
  await expect.poll(async () => Math.round((await state()).width)).toBe(Math.round(before.width + 60));
  const after=await state();
  expect(Math.round(after.panelLeft-before.panelLeft)).toBe(60);
  expect(after.panelLeft).toBeGreaterThan(after.width);
  await app.evaluate(async ({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`document.querySelector('.nw-resize-sidebar').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`));
  await expect.poll(async () => Math.round((await state()).width)).toBe(Math.round(before.width));
}

export async function checkReadingRails(app: ElectronApplication, screenshotPath?: string) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`document.getElementById('nw-read').click()`));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 20, width: 1700, height: 940 }));
  const geometry = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`(() => {
    const bounds=id=>{const r=document.getElementById(id).getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height}};
    const handle=document.querySelector('.nw-resize-actionRail').getBoundingClientRect();
    const rightHandle=document.querySelector('.nw-resize-statusRail').getBoundingClientRect();
    return {left:bounds('nw-action-rail'),center:bounds('sheld'),right:bounds('nw-story-dock'),input:bounds('send_form'),
      handle:{x:handle.x+handle.width/2,y:handle.y+45},rightHandle:{x:rightHandle.x+rightHandle.width/2,y:rightHandle.y+45},actionsParent:document.getElementById('nw-action-list').parentElement.id,
      collapsed:document.getElementById('nw-action-rail').classList.contains('nw-rail-collapsed')};
  })()`));
  await expect.poll(async () => (await geometry()).left.height).toBeGreaterThan(300);
  const before = await geometry();
  expect(before.actionsParent).toBe('nw-action-rail');
  expect(before.collapsed).toBe(false);
  expect(before.left.right).toBeLessThan(before.center.left);
  expect(before.center.right).toBeLessThan(before.right.left);
  expect(before.center.width).toBeGreaterThan(750);
  expect(before.input.height).toBeLessThan(160);
  if (screenshotPath) {
    const encoded = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fs.writeFile(screenshotPath, Buffer.from(encoded, 'base64'));
  }
  await app.evaluate(({ BrowserWindow }, point) => {
    const contents=BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents;
    const x=Math.round(point.x),y=Math.round(point.y);
    contents.sendInputEvent({type:'mouseMove',x,y});
    contents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
    contents.sendInputEvent({type:'mouseMove',x:x+40,y});
    contents.sendInputEvent({type:'mouseUp',x:x+40,y,button:'left',clickCount:1});
  }, before.handle);
  await expect.poll(async () => Math.round((await geometry()).left.width)).toBeGreaterThan(Math.round(before.left.width+20));
  expect((await geometry()).left.width).toBeLessThan(before.left.width+50);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`document.querySelector('.nw-resize-actionRail').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`));
  await expect.poll(async () => Math.round((await geometry()).left.width)).toBe(Math.round(before.left.width));
  await app.evaluate(({ BrowserWindow }, point) => {
    const contents=BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents;
    const x=Math.round(point.x),y=Math.round(point.y);
    contents.sendInputEvent({type:'mouseMove',x,y});
    contents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
    contents.sendInputEvent({type:'mouseMove',x:x-40,y});
    contents.sendInputEvent({type:'mouseUp',x:x-40,y,button:'left',clickCount:1});
  }, before.rightHandle);
  await expect.poll(async () => Math.round((await geometry()).right.width)).toBeGreaterThan(Math.round(before.right.width+20));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`document.querySelector('.nw-resize-statusRail').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`));
  await expect.poll(async () => Math.round((await geometry()).right.width)).toBe(Math.round(before.right.width));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 20, width: 1200, height: 900 }));
  await expect.poll(async () => (await geometry()).collapsed).toBe(true);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`document.querySelector('#nw-action-rail .nw-rail-collapse').click()`));
  await expect.poll(async () => (await geometry()).collapsed).toBe(false);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`document.querySelector('#nw-action-rail .nw-rail-collapse').click()`));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 20, width: 1440, height: 900 }));
}
