const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1248,height:960,webPreferences:{offscreen:true}});
  await win.loadFile(path.join(__dirname,'index.html'));
  await win.webContents.executeJavaScript('document.fonts.ready');
  await new Promise(r=>setTimeout(r,1200));
  fs.writeFileSync(path.join(__dirname,'comparison.png'),(await win.webContents.capturePage()).toPNG());
  console.log(await win.webContents.executeJavaScript('JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.body.scrollHeight,fonts:document.fonts.check("600 20px Familjen Grotesk")})'));
  app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
