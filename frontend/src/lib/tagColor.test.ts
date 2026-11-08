import { describe, it, expect } from 'vitest';
import { tagTextColor } from './tagColor';

describe('tagTextColor', () => {
  it('letters a pale tag in dark text', () => {
    expect(tagTextColor('#fde68a')).toBe('#18181b');
    expect(tagTextColor('#fff')).toBe('#18181b');
  });

  it('keeps white on a dark or saturated tag', () => {
    expect(tagTextColor('#3f3f46')).toBe('#ffffff');
    expect(tagTextColor('#b91c1c')).toBe('#ffffff');
  });

  it('falls back to white for a missing or odd color', () => {
    expect(tagTextColor(null)).toBe('#ffffff');
    expect(tagTextColor('rgb(1,2,3)')).toBe('#ffffff');
  });
});
