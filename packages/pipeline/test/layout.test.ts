import assert from 'node:assert/strict';
import {test} from 'node:test';
import {computeGrid,buildFilter,OUT_WIDTH,OUT_HEIGHT} from '../src/layout.ts';
test('camera visibility never changes game scale or crop dimensions',()=>{
  for(const [w,h] of [[1280,720],[1920,1080],[2560,1080],[1024,768]]){
    const off=computeGrid(w,h,null),on=computeGrid(w,h,{x:52,y:413,w:261,h:307});
    assert.equal(off.game.h,on.game.h);
    assert.equal(off.game.w,on.game.w);
    assert.equal(off.game.crop.w,on.game.crop.w);
    assert.equal(off.game.crop.h,on.game.crop.h);
    assert.equal(off.game.y,on.game.y);
    assert.equal(off.subTop,on.subTop);
    assert.equal(off.game.y,704);
    assert.ok(Math.abs(off.game.crop.w/off.game.crop.h-off.game.w/off.game.h)<.005);
    assert.ok(off.game.crop.x>=0 && off.game.crop.x+off.game.crop.w<=w);
    assert.ok(off.game.crop.y>=0 && off.game.crop.y+off.game.crop.h<=h);
    assert.doesNotMatch(buildFilter(off),/pad=|force_original_aspect_ratio=decrease/);
    assert.ok(off.game.w/off.game.h>1);
    assert.ok(off.game.x+off.game.w<=OUT_WIDTH);
    assert.ok(off.subTop<OUT_HEIGHT-300);
  }
});
test('invalid camera uses the same no-camera layout',()=>{
  assert.deepEqual(computeGrid(1280,720,{x:0,y:0,w:0,h:0}).game,computeGrid(1280,720,null).game);
});

test('wide cameras retain their existing size',()=>{
  const grid=computeGrid(1280,720,{x:10,y:10,w:900,h:300});
  assert.deepEqual(grid.cam,{crop:{x:10,y:10,w:900,h:300},x:0,y:105,w:1080,h:360});
  assert.equal(grid.game.h,812);
  assert.equal(grid.game.y,704);
});

test('minimap is beside the camera without changing face size or gameplay placement',()=>{
  const face={x:52,y:413,w:261,h:307},map={x:0,y:535,w:185,h:185};
  const base=computeGrid(1280,720,face);
  const grid=computeGrid(1280,720,face,{minimapRect:map});
  assert.deepEqual(grid.game,base.game);
  assert.equal(grid.cam!.w,base.cam!.w);
  assert.equal(grid.cam!.h,base.cam!.h);
  assert.equal(grid.cam!.y,base.cam!.y);
  assert.ok(grid.minimap!.x>grid.cam!.x+grid.cam!.w);
  assert.ok(grid.minimap!.x+grid.minimap!.w<=OUT_WIDTH);
  assert.ok(grid.minimap!.y+grid.minimap!.h<grid.game.y);
  assert.match(buildFilter(grid),/split=4/);
  assert.match(buildFilter(grid),/\[s3\]crop=185:185:0:535/);
  const noCam=computeGrid(1280,720,null,{minimapRect:map});
  assert.equal(noCam.game.y,grid.game.y);
  assert.equal(noCam.subTop,grid.subTop);
  assert.match(buildFilter(noCam),/\[s2\]crop=185:185:0:535/);
});
