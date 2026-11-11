import {test} from 'node:test';import assert from 'node:assert/strict';import {textDiffContext} from '../apps/studio/src/text-diff.ts';
test('long chapter review hides only unchanged text, including insertion and deletion at boundaries',()=>{
 const before='甲'.repeat(100000)+'旧的承诺'+'乙'.repeat(100000),after='甲'.repeat(100000)+'新的约定与代价'+'乙'.repeat(100000),v=textDiffContext(before,after);
 assert.equal(v.head,99910);assert.equal(v.tail,99910);assert.equal(v.before,'甲'.repeat(90)+'旧的承诺'+'乙'.repeat(90));assert.equal(v.after,'甲'.repeat(90)+'新的约定与代价'+'乙'.repeat(90));
 const added=textDiffContext('甲'.repeat(1000),'序章'+'甲'.repeat(1000));assert.equal(added.head,0);assert.ok(added.after.startsWith('序章'));assert.equal(added.tail,910);
 const removed=textDiffContext('甲'.repeat(1000)+'后记','甲'.repeat(1000));assert.equal(removed.tail,0);assert.ok(removed.before.endsWith('后记'));assert.equal(removed.after,'甲'.repeat(90));
});
