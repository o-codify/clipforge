/** A bounded, explicit test batch may exceed the development single-clip cap. */
export function renderCount(input: {count?:number;testBatch?:boolean}, development:boolean, fallback:number) {
  if(input.testBatch) {
    const count=input.count??1;
    if(!Number.isInteger(count)||count<1||count>100)throw new Error('Тестовая подборка: от 1 до 100 клипов');
    return count;
  }
  return development?1:input.count??fallback;
}

/** Keep score/diversity order, but reserve disjoint moments before parallel rendering. */
export function disjointMoments<T extends {start:number;end:number}>(candidates:T[], gap=3.4):T[] {
  const selected:T[]=[];
  for(const candidate of candidates) {
    if(!selected.some(other=>candidate.start<other.end+gap&&candidate.end+gap>other.start))selected.push(candidate);
  }
  return selected;
}
