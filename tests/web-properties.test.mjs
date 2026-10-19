import test from 'node:test';
import assert from 'node:assert/strict';
import { propertyDefinitions } from '../src/library.mjs';

test('file and directory definitions retain picker data without authorizing paths or forwarding code', () => {
  const result = propertyDefinitions({ general: { properties: {
    photo: { type: 'file', text: 'Photo', value: 'pictures/a.png', filetype: 'image', command: 'never-forward', code: 'never-forward' },
    random: { type: 'directory', value: 'D:/user-pictures', fileType: 'image', mode: 'ondemand', script: 'never-forward' },
    collection: { type: 'directory', mode: 'fetchall', filetype: 'video' },
  } } });
  assert.deepEqual({ ...result.photo }, { type: 'file', text: 'Photo', value: 'pictures/a.png', filetype: 'image' });
  assert.deepEqual({ ...result.random }, { type: 'directory', text: 'random', value: 'D:/user-pictures', filetype: 'image', mode: 'ondemand' });
  assert.deepEqual({ ...result.collection }, { type: 'directory', text: 'collection', value: '', filetype: 'video', mode: 'fetchall' });
  assert.equal(Object.hasOwn(result.random, 'selected'), false);
});

test('file controls reject credentials, malformed path values, unsupported types and dangerous keys', () => {
  const properties = JSON.parse('{"__proto__":{"type":"file","value":"private"}}');
  Object.assign(properties, { apiKey: { type: 'file', value: 'credential' }, password: { type: 'directory', value: 'credential' },
    invalid: { type: 'directory', value: {} }, invalidBoolean: { type: 'file', value: false },
    control: { type: 'file', value: 'safe\nunsafe' }, tooLong: { type: 'file', value: 'a'.repeat(4097) },
    script: { type: 'script', value: 'code' }, good: { type: 'directory', value: '', mode: 'unknown', filetype: 'executable' } });
  const result = propertyDefinitions({ general: { properties } });
  assert.deepEqual(Object.keys(result), ['good']); assert.equal(result.good.mode, 'ondemand'); assert.equal(Object.hasOwn(result.good, 'filetype'), false);
});
