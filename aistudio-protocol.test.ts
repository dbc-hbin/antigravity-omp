import { expect, test } from "bun:test";
import type { GenerateContentParameters } from "@oh-my-pi/pi-ai/providers/google-shared";
import { parseBenefitTier, parseCatalog } from "./aistudio-catalog";
import { decodeResponse, encodeRequest, StudioProtocolError, type Json } from "./aistudio-protocol";

// Wire positions and sample frames: pinned upstream docs/protocol.md sections 4-6.
function modelRow(id: string, modes: number[] = [], capabilities = [1,10,25,35,52]): Json[] {
  const row: Json[] = Array.from({length:83}, () => null);
  row[0] = `models/${id}`; row[3] = id;
  row[5] = 1048576; row[6] = 65536; row[7] = ["generateContent", "countTokens"];
  row[8] = 1; row[9] = 0.95; row[10] = 40;
  row[64] = capabilities; row[71] = [8192,32768,128,1,null,3,[1,3]];
  row[82] = modes;
  return row;
}
function model() {
  const value = parseCatalog([[modelRow("gemini-catalog-id")]], [0])[0];
  if (!value) throw new StudioProtocolError("test", "missing model");
  return value;
}
function source(text: string, fragment = 1): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({start(controller) {
    for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i,i+fragment));
    controller.close();
  }});
}
async function collect(text: string) {
  const values = [];
  for await (const value of decodeResponse(source(text))) values.push(value);
  return values;
}
const textContent: Json[] = [[[null,"42"]],"model"];
const textFrame: Json[] = [[[textContent]]];
const finishFrame: Json[] = [[[null,1]],null,[27,1,28,null,null,null,null,0,null,0],null,null,null,null,"v1_TURN_TOKEN"];

test.each([
  {tier:0, ids:["free"]},
  {tier:1, ids:["free","pro","either"]},
  {tier:2, ids:["free","pro","ultra","either"]},
  {tier:3, ids:["free"]},
])("filters paid-key, Pro and Ultra access modes for tier $tier", ({tier,ids}) => {
  const rows = [modelRow("free"),modelRow("key",[1]),modelRow("pro",[3]),modelRow("ultra",[4]),modelRow("either",[1,3])];
  expect(parseCatalog([rows], [tier,"ignored later field"]).map(m => m.id)).toEqual([...ids]);
});

test("keeps native limits and excludes non-GenerateContent and media routes", () => {
  const interaction = modelRow("interaction"); interaction[78] = [null,null,false,2];
  const embedding = modelRow("embedding"); embedding[7] = ["embedContent"];
  const continuation = modelRow("continue",[],[1,10,91]);
  const models = parseCatalog([[continuation,interaction,embedding,modelRow("image",[],[1,21])]],[]);
  expect(models.map(m => [m.id,m.contextWindow,m.maxTokens,m.outputContinuation])).toEqual([["continue",1048576,32768,true]]);
});

test.each([{tier:[]},{tier:[null]},{tier:[0]}])("recognizes omitted Free benefit field $tier", ({tier}) => {
  expect(parseBenefitTier(tier)).toBe(0);
});

test("rejects unknown benefit tiers rather than assuming Free", () => {
  expect(() => parseBenefitTier([4])).toThrow("unknown benefit tier");
});

test("encodes recursive function schemas and typed Struct results without rewriting data", () => {
  const params: GenerateContentParameters = {model:"ignored alias", contents:[
    {role:"user",parts:[{text:"first"},{inlineData:{mimeType:"image/png",data:"AQ=="}},{text:"second"}]},
    {role:"model",parts:[{functionCall:{name:"ping",args:{value:[null,false,3,"x",{nested:true}]},id:"call-1"},thoughtSignature:"signed"}]},
    {role:"user",parts:[{functionResponse:{name:"ping",response:{ok:true},id:"call-1"}}]},
  ],config:{systemInstruction:{parts:[{text:"system one"},{text:"system two"}]}, maxOutputTokens:512, temperature:0.2, tools:[{functionDeclarations:[{name:"ping",description:"checks service",parameters:{type:"OBJECT",required:["items"],properties:{items:{type:"ARRAY",items:{type:"OBJECT",properties:{x:{type:"INTEGER"}}}}}}}]}]}};
  const {body,prompt} = encodeRequest(model(),params);
  expect(prompt).toBe("first second");
  expect(body[0]).toBe("models/gemini-catalog-id");
  expect(body[4]).toBeNull();
  expect(body[5]).toEqual([[[null,"system one"],[null,"system two"]],"user"]);
  expect(body[1]).toEqual([
    [[ [null,"first"], [null,null,["image/png","AQ=="]], [null,"second"] ],"user"],
    [[ [null,null,null,null,null,null,null,null,null,null,["ping",[[["value",[null,null,null,null,null,[[[0],[null,null,null,false],[null,3],[null,null,"x"],[null,null,null,null,[[["nested",[null,null,null,true]]]]]]]]]]],"call-1"],null,null,null,"signed"] ],"model"],
    [[ [null,null,null,null,null,null,null,null,null,null,null,["ping",[[["ok",[null,null,null,true]]]],"call-1"]] ],"user"],
  ]);
  expect(body[6]).toEqual([[null,[["ping",expect.stringContaining("checks service"),[6,null,null,null,null,null,[["items",[5,null,null,null,null,[6,null,null,null,null,null,[["x",[3]]]]]]],["items"]]]]]]);
});

test("streams a complete sparse frame before the growing root closes", async () => {
  const stream = new TransformStream<Uint8Array,Uint8Array>();
  const writer = stream.writable.getWriter();
  const iterator = decodeResponse(stream.readable);
  const first = iterator.next();
  const write = writer.write(new TextEncoder().encode(`[[${JSON.stringify(textFrame).replace('[null,"42"]','[,"42"]')},`));
  expect((await first).value?.candidates?.[0]?.content?.parts).toEqual([{text:"42"}]);
  await write;
  const end = iterator.next();
  await writer.write(new TextEncoder().encode(`${JSON.stringify(finishFrame)}]]`));
  await writer.close();
  expect((await end).value?.usageMetadata).toEqual({promptTokenCount:27,candidatesTokenCount:1,totalTokenCount:28,thoughtsTokenCount:0});
  expect((await iterator.next()).done).toBe(true);
});

test("preserves fragmented Unicode thought, standalone signature, function and usage frames", async () => {
  const thought: Json[] = Array.from({length:15}, () => null); thought[1] = "思考"; thought[12] = 1;
  const signature: Json[] = Array.from({length:15}, () => null); signature[14] = "opaque";
  const call: Json[] = Array.from({length:11}, () => null); call[10] = ["ping",[[["ok",[null,null,null,true]]]],"c1"];
  const content: Json[] = [[thought,signature,call],"model"];
  const frame: Json[] = [[[content]]];
  const token: string[] = [];
  const chunks = [];
  for await (const chunk of decodeResponse(source(JSON.stringify([[frame,finishFrame]])), value => token.push(value))) chunks.push(chunk);
  expect(chunks.flatMap(c => c.candidates?.flatMap(v => v.content?.parts ?? []) ?? [])).toEqual([{text:"思考",thought:true},{thoughtSignature:"opaque"},{functionCall:{name:"ping",args:{ok:true},id:"c1"}}]);
  expect(token).toEqual(["v1_TURN_TOKEN"]);
  expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe("STOP");
});

test("propagates late RPC failure after content and a finish frame", async () => {
  const iterator = decodeResponse(source(JSON.stringify([[textFrame,finishFrame],[13,"backend failed"]])));
  expect((await iterator.next()).value?.candidates?.[0]?.content?.parts).toEqual([{text:"42"}]);
  return expect(iterator.next()).rejects.toMatchObject({code:13,message:expect.stringContaining("backend failed")});
});

test("restores long function names and preserves server function results", async () => {
  const name = "lookup_" + "a".repeat(80);
  const params: GenerateContentParameters = {model:"gemini-catalog-id",contents:[{role:"model",parts:[{functionCall:{name,args:{}}}]}],config:{tools:[{functionDeclarations:[{name}]}]}};
  const encoded = encodeRequest(model(),params);
  const contents = encoded.body[1];
  if (!Array.isArray(contents)) throw new StudioProtocolError("test", "contents missing");
  const content = contents[0];
  if (!Array.isArray(content) || !Array.isArray(content[0])) throw new StudioProtocolError("test", "parts missing");
  const part = content[0][0];
  if (!Array.isArray(part) || !Array.isArray(part[10])) throw new StudioProtocolError("test", "call missing");
  const wireName = part[10][0];
  expect(typeof wireName === "string" && wireName.length).toBe(63);
  const result: Json[] = Array.from({length:12}, () => null);
  result[11] = [wireName ?? null,[[["ok",[null,null,null,false]]]],"r1"];
  const responseFrame: Json[] = [[[[[part,result],"model"]]]];
  const chunks = [];
  for await (const chunk of decodeResponse(source(JSON.stringify([[responseFrame,finishFrame],[0]]),7),undefined,params)) chunks.push(chunk);
  expect(chunks[0]?.candidates?.[0]?.content?.parts).toEqual([{functionCall:{name,args:{}}},{functionResponse:{name,response:{ok:false},id:"r1"}}]);
});

test("retains non-STOP finish reasons and unrecognized provider codes", async () => {
  const terminal: Json[] = [[[null,19,null,"malformed output"]]];
  const chunks = await collect(JSON.stringify([[terminal],[0]]));
  expect(chunks[0]?.candidates?.[0]).toMatchObject({finishReason:"MALFORMED_RESPONSE",finishMessage:"malformed output"});
  const unknownFrame: Json[] = [[[null,22]]];
  const unknown = await collect(JSON.stringify([[unknownFrame]]));
  expect(unknown[0]?.candidates?.[0]).toMatchObject({finishReason:"OTHER",providerFinishReason:"provider_22"});
});

test.each([
  `[[${JSON.stringify(textFrame)}`,
  JSON.stringify([[textFrame]]),
  `[[${JSON.stringify(textFrame)},${JSON.stringify(finishFrame)}]`,
])("rejects truncated or unfinished streams after content: %s", text => {
  return expect(collect(text)).rejects.toThrow();
});
