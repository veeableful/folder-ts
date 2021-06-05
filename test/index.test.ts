import { analyze } from '../src'

describe('analyze "lunar new year"', () => {
  it('works', () => {
    expect(analyze('lunar new year')).toEqual(['lunar', 'new', 'year'])
  })
})
