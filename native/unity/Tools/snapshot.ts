// Temporary Track C generator. Track B owns tools/headset's eventual canonical one.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// TypeScript 7 no longer exports the legacy compiler API. This tool isolates
// a verified 5.9.3 compiler without changing root npm configuration.
import ts from './.cache/package/lib/typescript.js';
import * as layout from '../../../src/shared/layout.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, '../..');
const input = resolve(root, 'src/shared/protocol.ts');
const program = ts.createProgram([input], { strictNullChecks: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext });
const checker = program.getTypeChecker();
const source = program.getSourceFile(input)!;
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = program
  .getSourceFiles()
  .filter((f) => f.fileName.startsWith(resolve(root, 'src/shared')))
  .map((f) => ({ path: relative(root, f.fileName), sha256: sha(f.text) }))
  .sort((a, b) => a.path.localeCompare(b.path));
const sourceHash = sha(source.text);
const definitions: string[] = [];
const names = new Map<ts.Type, string>();
const used = new Set<string>();
const server: [string, string][] = [];
const client: [string, string][] = [];
const clean = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
const pascal = (value: string) =>
  value
    .split(/[^a-zA-Z0-9]+/)
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join('');
function unique(preferred: string) {
  let name = clean(preferred),
    i = 2;
  while (used.has(name)) name = clean(preferred) + i++;
  used.add(name);
  return name;
}
function fieldType(type: ts.Type, suggested: string): string {
  if (type.isUnion()) {
    const parts = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    const nullable = parts.length !== type.types.length;
    if (parts.length === 1) {
      const inner = fieldType(parts[0], suggested);
      return nullable && ['double', 'bool'].includes(inner) ? inner + '?' : inner;
    }
    if (parts.every((t) => t.flags & ts.TypeFlags.StringLike)) return 'string';
    if (parts.every((t) => t.flags & ts.TypeFlags.BooleanLike)) return nullable ? 'bool?' : 'bool';
    // Preserve heterogeneous unions/tuples losslessly rather than guess a wire shape.
    return 'JToken';
  }
  if (type.flags & ts.TypeFlags.StringLike) return 'string';
  if (type.flags & ts.TypeFlags.NumberLike) return 'double';
  if (type.flags & ts.TypeFlags.BooleanLike) return 'bool';
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Null)) return 'JToken';
  if (checker.isTupleType(type)) return 'JArray';
  if (checker.isArrayType(type)) return fieldType(checker.getTypeArguments(type as ts.TypeReference)[0], suggested + 'Item') + '[]';
  const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (stringIndex || numberIndex) return 'Dictionary<string, ' + fieldType((stringIndex ?? numberIndex)!, suggested + 'Value') + '>';
  if (checker.getPropertiesOfType(type).length) {
    let preferred = type.getSymbol()?.getName();
    if (!preferred || preferred.startsWith('__')) preferred = suggested;
    if ((type as ts.TypeReference).typeArguments?.length) preferred += (type as ts.TypeReference).typeArguments!.map((t) => clean(checker.typeToString(t))).join('');
    return emitClass(type, preferred);
  }
  return 'JToken';
}
function emitClass(type: ts.Type, preferred: string, tag?: string): string {
  const prior = names.get(type);
  if (prior) return prior;
  const name = unique(preferred);
  names.set(type, name);
  const fields = checker.getPropertiesOfType(type).map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? source;
    const wire = property.getName();
    const typeName = fieldType(checker.getTypeOfSymbolAtLocation(property, declaration), name + pascal(wire));
    const value = wire === 't' && tag ? ` = ${JSON.stringify(tag)}` : '';
    return `        [JsonProperty(${JSON.stringify(wire)})] public ${typeName} @${clean(wire)}${value};`;
  });
  definitions.push(`    public sealed class ${name}\n    {\n${fields.join('\n')}\n        [JsonExtensionData] public Dictionary<string, JToken> Extra;\n    }`);
  return name;
}
for (const statement of source.statements) {
  if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
  const type = checker.getTypeAtLocation(statement.name);
  const name = statement.name.text;
  if (name === 'ServerMsg' || name === 'ClientMsg') {
    if (!type.isUnion()) throw new Error(`Expected tagged union: ${name}`);
    for (const variant of type.types) {
      const property = variant.getProperty('t');
      if (!property) throw new Error('Message lacks discriminator');
      const discriminator = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? source);
      if (!discriminator.isStringLiteral()) throw new Error('Message discriminator is not a literal');
      const tag = discriminator.value;
      const generated = emitClass(variant, (name === 'ServerMsg' ? 'Server' : 'Client') + pascal(tag), tag);
      (name === 'ServerMsg' ? server : client).push([tag, generated]);
    }
  } else if (ts.isInterfaceDeclaration(statement) && !statement.typeParameters?.length) {
    emitClass(type, name);
  }
}
function table(name: string, entries: [string, string][]) {
  return `        public static readonly IReadOnlyDictionary<string, Type> ${name} = new Dictionary<string, Type>\n        {\n${entries
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tag, type]) => `            [${JSON.stringify(tag)}] = typeof(${type}),`)
    .join('\n')}\n        };`;
}
const code = `// Generated by native/unity/Tools/snapshot.ts. DO NOT EDIT.\n// Source commit: ${commit}\n// protocol.ts SHA-256: ${sourceHash}\nusing System;\nusing System.Collections.Generic;\nusing Newtonsoft.Json;\nusing Newtonsoft.Json.Linq;\n\nnamespace DroidOffice.Protocol\n{\n${definitions.join('\n\n')}\n\n    public static class MessageTypes\n    {\n        public const string SourceCommit = ${JSON.stringify(commit)};\n        public const string SourceSha256 = ${JSON.stringify(sourceHash)};\n${table('Server', server)}\n${table('Client', client)}\n    }\n}\n`;
const constants = Object.fromEntries(Object.entries(layout).filter(([, value]) => typeof value !== 'function' && !(value instanceof Map)));
const layoutSource = readFileSync(resolve(root, 'src/shared/layout.ts'));
const files = new Map([
  ['Assets/DroidOffice/Protocol/Generated/Protocol.g.cs', code],
  ['Assets/DroidOffice/Protocol/Generated/source.json', JSON.stringify({ commit, protocolSha256: sourceHash, inputs: identity }, null, 2) + '\n'],
  ['Assets/DroidOffice/Layout/office-layout.json', JSON.stringify({ sourceCommit: commit, sourceSha256: sha(layoutSource), constants }, null, 2) + '\n'],
]);
// Commit identity is evidence, not drift: unrelated parallel commits need not regenerate DTOs.
const normalize = (text: string) =>
  text
    .replaceAll(commit, '<commit>')
    .replace(/Source commit: [0-9a-f]{40}/g, 'Source commit: <commit>')
    .replace(/SourceCommit = "[0-9a-f]{40}"/g, 'SourceCommit = "<commit>"')
    .replace(/"(?:sourceCommit|commit)": "[0-9a-f]{40}"/g, '"commit": "<commit>"');
for (const [path, content] of files) {
  const destination = resolve(project, path);
  if (process.argv.includes('--check')) {
    if (normalize(readFileSync(destination, 'utf8')) !== normalize(content)) throw new Error(`Snapshot drift: ${path}`);
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${server.length} server and ${client.length} client message types, ${definitions.length} DTOs.`);
