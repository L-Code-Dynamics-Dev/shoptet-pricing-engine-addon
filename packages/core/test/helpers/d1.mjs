import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
export function testD1({through=null}={}) {
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../../../../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort()) {
   if(through && file>through)continue;
   sql.exec(readFileSync(new URL('../../../../migrations/'+file,import.meta.url),'utf8'));
 }
 const db={sql,prepare(query){return {bind(...args){const stmt=sql.prepare(query);return {async first(){return stmt.get(...args)??null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:Number(stmt.run(...args).changes)}};}};}};},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 return db;
}
