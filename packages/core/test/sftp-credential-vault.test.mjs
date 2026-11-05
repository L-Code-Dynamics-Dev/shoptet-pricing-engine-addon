import test from 'node:test';
import assert from 'node:assert/strict';
import {createSftpCredentialVault} from '../src/sftp-credential-vault.mjs';
const HOST_KEY='SHA256:'+'A'.repeat(43);
const key='a'.repeat(64);
function db(){const rows=new Map();return {rows,prepare(sql){return {bind(...args){return {async run(){rows.set(args[0],{iv_b64:args[1],ciphertext_b64:args[2]});return {success:true}},async first(){return rows.get(args[0])??null}}}}}}}
test('vault encrypts credentials and decrypts for matching shop',async()=>{const d=db(),v=createSftpCredentialVault({db:d,masterKeyHex:key});await v.save('shop-a',{host:'example.test',username:'user',password:'sensitive-secret',hostKeySha256:HOST_KEY});assert.ok(!JSON.stringify([...d.rows]).includes('sensitive-secret'));assert.equal((await v.resolve('shop-a')).password,'sensitive-secret');});
test('vault refuses cross-shop ciphertext substitution',async()=>{const d=db(),v=createSftpCredentialVault({db:d,masterKeyHex:key});await v.save('shop-a',{host:'example.test',username:'user',password:'sensitive-secret',hostKeySha256:HOST_KEY});d.rows.set('shop-b',d.rows.get('shop-a'));await assert.rejects(v.resolve('shop-b'),/unavailable/);});
test('vault rejects missing key and missing pin',async()=>{const d=db(),v=createSftpCredentialVault({db:d,masterKeyHex:key});await assert.rejects(v.save('shop-a',{host:'example.test',username:'u',password:'p'}),/Invalid credentials/);await assert.rejects(createSftpCredentialVault({db:d,masterKeyHex:'wrong'}).save('shop-a',{host:'example.test',username:'u',password:'p',hostKeySha256:HOST_KEY}),/Vault unavailable/);});
