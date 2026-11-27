import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
const output='dist-browser';
const result=await build({
 entryPoints:['src/browser.ts'],bundle:true,platform:'browser',format:'esm',
 target:'es2022',outfile:output+'/chatbus.mjs',minify:true,
 metafile:true,write:false,legalComments:'inline',
 banner:{js:'/*! Chatbus — Copyright (c) 2026 myrqyry. Elastic-2.0. https://github.com/myrqyry/chatbus */'},
});
if(Object.keys(result.metafile.inputs).some(path=>path.includes('node_modules/')) ||
 Object.values(result.metafile.outputs).some(file=>file.imports.some(item=>item.external)))
 throw new Error('Browser build must be self-contained first-party code');
mkdirSync(output,{recursive:true});
for(const file of result.outputFiles)writeFileSync(file.path,file.contents);
for(const file of ['LICENSE','NOTICE'])copyFileSync(file,output+'/'+file);
console.log('Built browser-only Chatbus ESM with original license and notice');
