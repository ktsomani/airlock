import {describe,it,expect,vi} from 'vitest';
import adapter,{callPaperTool} from '../examples/live-adapter.mjs';
const metadata={file:{id:'file-1'},contentHash:{tokens:'fixture'}};
const response=(payload:unknown)=>({content:[{type:'text',text:JSON.stringify(metadata)},{type:'text',text:typeof payload==='string'?payload:JSON.stringify(payload)}]});
describe('Paper response envelopes',()=>{
 it('keeps metadata and the actual overview',async()=>{
   expect(await callPaperTool({callTool:async()=>response({rootNodeId:'root-1'})},'get_basic_info',{})).toEqual({...metadata,rootNodeId:'root-1'});
 });
 it('preserves empty string payloads',async()=>{
   expect(await callPaperTool({callTool:async()=>response('')},'get_jsx',{})).toBe('');
 });
 it('surfaces the actual error after metadata',async()=>{
   await expect(callPaperTool({callTool:async()=>({...response('Node does not exist'),isError:true})},'get_jsx',{})).rejects.toThrow('Node does not exist');
 });
 it('captures a verified empty page using its root, never its file ID',async()=>{
   const callTool=vi.fn(async({name,arguments:args})=>{
     if(name==='get_basic_info')return response({pageId:'p1',pages:[{id:'p1',type:'page'}],rootNodeId:'root-1',tokens:{items:[]}});
     expect(args).toEqual({fileId:'file-1',nodeId:'root-1'});
     expect(name).toBe('get_children');return response({children:[],count:0});
   });
   expect(await adapter.capture({callTool})).toEqual({canvas:{'file-1:root-1':[]},tokens:{}});
   expect(callTool).toHaveBeenCalledTimes(2);
 });
});
