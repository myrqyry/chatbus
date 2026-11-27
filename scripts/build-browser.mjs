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
writeFileSync(output+'/index.html',`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chatbus browser runtime</title><h1>Chatbus browser runtime</h1>
<p>Credential-free Twitch and Kick public chat and third-party emote discovery. This is a browser library, not a hosted relay.</p>
<p><a href="./chatbus.mjs">Browser ESM (current main build)</a> · <a href="./LICENSE">ELv2 license</a> · <a href="./NOTICE">Attribution</a></p>
<p><a href="https://github.com/myrqyry/chatbus">Source, API documentation and commit history</a>. For reproducible apps, pin a source commit instead of the rolling module URL.</p></html>
`);
console.log('Built browser-only Chatbus ESM with original license and notice');
