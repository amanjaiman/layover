import fs from 'node:fs';
const dir = new URL('./flight/', import.meta.url);
fs.mkdirSync(dir,{recursive:true});
let source = fs.readFileSync(new URL('./create-options.mjs',import.meta.url),'utf8');
source = source.replace("const dir = new URL('./', import.meta.url);", "const dir = new URL('./', import.meta.url);");
const start=source.indexOf('const marks = {');
const end=source.indexOf('\nconst svg',start);
source=source.slice(0,start)+`const marks = {
  wing: '<path d="M12 14H52c3 0 4.5 3.6 2.3 5.7L31 42.2c-2.4 2.3-6.3 1.8-8.1-1L8.6 20.3C6.8 17.6 8.7 14 12 14Z" fill="currentColor"/><path d="m34 46 14-13.5V49c0 3.4-4 5.2-6.5 2.9Z" fill="currentColor"/>',
  stopover: '<path d="M8 48v-4c0-6.63 5.37-12 12-12M44 32c6.63 0 12-5.37 12-12v-4" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><circle cx="32" cy="32" r="7" fill="currentColor"/>'
};`+source.slice(end);
source=source.replace('Layover / Identity explorations','Layover / Aviation explorations');
source=source.replace('Two quiet marks for keeping your thoughts close while an agent works. Drawn from the warm surfaces, teal accent, and soft geometry of Foundations.','A folded page with a sense of flight. A quiet stop between two legs of a journey. Two ways to connect the name to the time while your agent works.');
source=source.replace("card('landing',1,'Landing','Rest & continuity','An open, rounded L gives a thought somewhere to land. A small circle stays held above the baseline: pause, capture, and return when you’re ready.')", "card('wing',3,'Folded wing','Paper & possibility','A broad paper wing with a turned-under corner. The open diagonal crease brings a notebook into the flight metaphor: a thought taking shape while work continues.')");
source=source.replace("card('alongside',2,'Alongside','Notes & companionship','Two offset pages share a narrow margin. Your thinking and the agent’s work sit side by side, each with its own space and rhythm.')", "card('stopover',4,'Stopover','Pause & onward','Two soft route segments meet around a resting point. The space around the dot makes the pause visible, while the path holds a clear sense of onward movement.')");
source=source.replace('Recommendation: Landing for the clearest app identity.','Folded wing: expressive. Stopover: calm and purposeful.');
fs.writeFileSync(new URL('create-options.mjs',dir),source);
await import(new URL('create-options.mjs',dir));
fs.copyFileSync(new URL('./render.cjs',import.meta.url),new URL('render.cjs',dir));
