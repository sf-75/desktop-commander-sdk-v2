import fs from 'fs';
const [ready,trigger,piece]=process.argv.slice(2);
const pieces={markup:'<div>',dollar:'costs 5$',hash:'see issue #'};
if(!(piece in pieces))process.exit(2);
process.stdout.write(pieces[piece],()=>fs.writeFileSync(ready,'ready'));
const poll=setInterval(()=>{if(!fs.existsSync(trigger))return;clearInterval(poll);process.stdout.write(' and the rest of the line\nnext line\n');setInterval(()=>{},1000);},20);
setTimeout(()=>process.exit(0),45000).unref();
