// Static, self-authored list of ISO 3166-1 alpha-2 country codes with
// approximate centroid coordinates, used to place map markers and drive
// the region chip picker's suggestions. Deliberately no country *names*
// here — those are resolved at render time via
// `Intl.DisplayNames([lang], { type: 'region' })`, so this file needs no
// per-language translation data. Flag emoji are computed from the code
// (see `flagEmoji` below), not stored either.

export interface CountryCentroid {
  code: string;
  lat: number;
  lng: number;
}

export const COUNTRIES: CountryCentroid[] = [
  { code: 'AD', lat: 42.55, lng: 1.58 }, { code: 'AE', lat: 23.42, lng: 53.85 },
  { code: 'AF', lat: 33.94, lng: 67.71 }, { code: 'AG', lat: 17.06, lng: -61.80 },
  { code: 'AL', lat: 41.15, lng: 20.17 }, { code: 'AM', lat: 40.07, lng: 45.04 },
  { code: 'AO', lat: -11.20, lng: 17.87 }, { code: 'AR', lat: -38.42, lng: -63.62 },
  { code: 'AT', lat: 47.52, lng: 14.55 }, { code: 'AU', lat: -25.27, lng: 133.78 },
  { code: 'AZ', lat: 40.14, lng: 47.58 }, { code: 'BA', lat: 43.92, lng: 17.68 },
  { code: 'BB', lat: 13.19, lng: -59.54 }, { code: 'BD', lat: 23.68, lng: 90.36 },
  { code: 'BE', lat: 50.50, lng: 4.47 }, { code: 'BF', lat: 12.24, lng: -1.56 },
  { code: 'BG', lat: 42.73, lng: 25.49 }, { code: 'BH', lat: 26.07, lng: 50.56 },
  { code: 'BI', lat: -3.37, lng: 29.92 }, { code: 'BJ', lat: 9.31, lng: 2.32 },
  { code: 'BN', lat: 4.54, lng: 114.73 }, { code: 'BO', lat: -16.29, lng: -63.59 },
  { code: 'BR', lat: -14.24, lng: -51.93 }, { code: 'BS', lat: 25.03, lng: -77.40 },
  { code: 'BT', lat: 27.51, lng: 90.43 }, { code: 'BW', lat: -22.33, lng: 24.68 },
  { code: 'BY', lat: 53.71, lng: 27.95 }, { code: 'BZ', lat: 17.19, lng: -88.50 },
  { code: 'CA', lat: 56.13, lng: -106.35 }, { code: 'CD', lat: -4.04, lng: 21.76 },
  { code: 'CF', lat: 6.61, lng: 20.94 }, { code: 'CG', lat: -0.23, lng: 15.83 },
  { code: 'CH', lat: 46.82, lng: 8.23 }, { code: 'CI', lat: 7.54, lng: -5.55 },
  { code: 'CL', lat: -35.68, lng: -71.54 }, { code: 'CM', lat: 7.37, lng: 12.35 },
  { code: 'CN', lat: 35.86, lng: 104.20 }, { code: 'CO', lat: 4.57, lng: -74.30 },
  { code: 'CR', lat: 9.75, lng: -83.75 }, { code: 'CU', lat: 21.52, lng: -77.78 },
  { code: 'CV', lat: 16.00, lng: -24.01 }, { code: 'CY', lat: 35.13, lng: 33.43 },
  { code: 'CZ', lat: 49.82, lng: 15.47 }, { code: 'DE', lat: 51.17, lng: 10.45 },
  { code: 'DJ', lat: 11.83, lng: 42.59 }, { code: 'DK', lat: 56.26, lng: 9.50 },
  { code: 'DM', lat: 15.41, lng: -61.37 }, { code: 'DO', lat: 18.74, lng: -70.16 },
  { code: 'DZ', lat: 28.03, lng: 1.66 }, { code: 'EC', lat: -1.83, lng: -78.18 },
  { code: 'EE', lat: 58.60, lng: 25.01 }, { code: 'EG', lat: 26.82, lng: 30.80 },
  { code: 'ER', lat: 15.18, lng: 39.78 }, { code: 'ES', lat: 40.46, lng: -3.75 },
  { code: 'ET', lat: 9.15, lng: 40.49 }, { code: 'FI', lat: 61.92, lng: 25.75 },
  { code: 'FJ', lat: -17.71, lng: 178.07 }, { code: 'FM', lat: 7.43, lng: 150.55 },
  { code: 'FR', lat: 46.23, lng: 2.21 }, { code: 'GA', lat: -0.80, lng: 11.61 },
  { code: 'GB', lat: 55.38, lng: -3.44 }, { code: 'GD', lat: 12.26, lng: -61.60 },
  { code: 'GE', lat: 42.32, lng: 43.36 }, { code: 'GH', lat: 7.95, lng: -1.02 },
  { code: 'GM', lat: 13.44, lng: -15.31 }, { code: 'GN', lat: 9.95, lng: -9.70 },
  { code: 'GQ', lat: 1.65, lng: 10.27 }, { code: 'GR', lat: 39.07, lng: 21.82 },
  { code: 'GT', lat: 15.78, lng: -90.23 }, { code: 'GW', lat: 11.80, lng: -15.18 },
  { code: 'GY', lat: 4.86, lng: -58.93 }, { code: 'HN', lat: 15.20, lng: -86.24 },
  { code: 'HR', lat: 45.10, lng: 15.20 }, { code: 'HT', lat: 18.97, lng: -72.29 },
  { code: 'HU', lat: 47.16, lng: 19.50 }, { code: 'ID', lat: -0.79, lng: 113.92 },
  { code: 'IE', lat: 53.41, lng: -8.24 }, { code: 'IL', lat: 31.05, lng: 34.85 },
  { code: 'IN', lat: 20.59, lng: 78.96 }, { code: 'IQ', lat: 33.22, lng: 43.68 },
  { code: 'IR', lat: 32.43, lng: 53.69 }, { code: 'IS', lat: 64.96, lng: -19.02 },
  { code: 'IT', lat: 41.87, lng: 12.57 }, { code: 'JM', lat: 18.11, lng: -77.30 },
  { code: 'JO', lat: 30.59, lng: 36.24 }, { code: 'JP', lat: 36.20, lng: 138.25 },
  { code: 'KE', lat: -0.02, lng: 37.91 }, { code: 'KG', lat: 41.20, lng: 74.77 },
  { code: 'KH', lat: 12.57, lng: 104.99 }, { code: 'KI', lat: 1.87, lng: -157.36 },
  { code: 'KM', lat: -11.88, lng: 43.87 }, { code: 'KN', lat: 17.36, lng: -62.78 },
  { code: 'KP', lat: 40.34, lng: 127.51 }, { code: 'KR', lat: 35.91, lng: 127.77 },
  { code: 'KW', lat: 29.31, lng: 47.48 }, { code: 'KZ', lat: 48.02, lng: 66.92 },
  { code: 'LA', lat: 19.86, lng: 102.50 }, { code: 'LB', lat: 33.85, lng: 35.86 },
  { code: 'LC', lat: 13.91, lng: -60.98 }, { code: 'LI', lat: 47.17, lng: 9.56 },
  { code: 'LK', lat: 7.87, lng: 80.77 }, { code: 'LR', lat: 6.43, lng: -9.43 },
  { code: 'LS', lat: -29.61, lng: 28.23 }, { code: 'LT', lat: 55.17, lng: 23.88 },
  { code: 'LU', lat: 49.82, lng: 6.13 }, { code: 'LV', lat: 56.88, lng: 24.60 },
  { code: 'LY', lat: 26.34, lng: 17.23 }, { code: 'MA', lat: 31.79, lng: -7.09 },
  { code: 'MC', lat: 43.74, lng: 7.42 }, { code: 'MD', lat: 47.41, lng: 28.37 },
  { code: 'ME', lat: 42.71, lng: 19.37 }, { code: 'MG', lat: -18.77, lng: 46.87 },
  { code: 'MH', lat: 7.13, lng: 171.18 }, { code: 'MK', lat: 41.61, lng: 21.75 },
  { code: 'ML', lat: 17.57, lng: -4.00 }, { code: 'MM', lat: 21.91, lng: 95.96 },
  { code: 'MN', lat: 46.86, lng: 103.85 }, { code: 'MR', lat: 21.01, lng: -10.94 },
  { code: 'MT', lat: 35.94, lng: 14.38 }, { code: 'MU', lat: -20.35, lng: 57.55 },
  { code: 'MV', lat: 3.20, lng: 73.22 }, { code: 'MW', lat: -13.25, lng: 34.30 },
  { code: 'MX', lat: 23.63, lng: -102.55 }, { code: 'MY', lat: 4.21, lng: 101.98 },
  { code: 'MZ', lat: -18.67, lng: 35.53 }, { code: 'NA', lat: -22.96, lng: 18.49 },
  { code: 'NE', lat: 17.61, lng: 8.08 }, { code: 'NG', lat: 9.08, lng: 8.68 },
  { code: 'NI', lat: 12.87, lng: -85.21 }, { code: 'NL', lat: 52.13, lng: 5.29 },
  { code: 'NO', lat: 60.47, lng: 8.47 }, { code: 'NP', lat: 28.39, lng: 84.12 },
  { code: 'NR', lat: -0.52, lng: 166.93 }, { code: 'NZ', lat: -40.90, lng: 174.89 },
  { code: 'OM', lat: 21.51, lng: 55.92 }, { code: 'PA', lat: 8.54, lng: -80.78 },
  { code: 'PE', lat: -9.19, lng: -75.02 }, { code: 'PG', lat: -6.31, lng: 143.96 },
  { code: 'PH', lat: 12.88, lng: 121.77 }, { code: 'PK', lat: 30.38, lng: 69.35 },
  { code: 'PL', lat: 51.92, lng: 19.15 }, { code: 'PS', lat: 31.95, lng: 35.23 },
  { code: 'PT', lat: 39.40, lng: -8.22 }, { code: 'PW', lat: 7.51, lng: 134.58 },
  { code: 'PY', lat: -23.44, lng: -58.44 }, { code: 'QA', lat: 25.35, lng: 51.18 },
  { code: 'RO', lat: 45.94, lng: 24.97 }, { code: 'RS', lat: 44.02, lng: 21.01 },
  { code: 'RU', lat: 61.52, lng: 105.32 }, { code: 'RW', lat: -1.94, lng: 29.87 },
  { code: 'SA', lat: 23.89, lng: 45.08 }, { code: 'SB', lat: -9.65, lng: 160.16 },
  { code: 'SC', lat: -4.68, lng: 55.49 }, { code: 'SD', lat: 12.86, lng: 30.22 },
  { code: 'SE', lat: 60.13, lng: 18.64 }, { code: 'SG', lat: 1.35, lng: 103.82 },
  { code: 'SI', lat: 46.15, lng: 14.99 }, { code: 'SK', lat: 48.67, lng: 19.70 },
  { code: 'SL', lat: 8.46, lng: -11.78 }, { code: 'SM', lat: 43.94, lng: 12.46 },
  { code: 'SN', lat: 14.50, lng: -14.45 }, { code: 'SO', lat: 5.15, lng: 46.20 },
  { code: 'SR', lat: 3.92, lng: -56.03 }, { code: 'SS', lat: 6.88, lng: 31.31 },
  { code: 'ST', lat: 0.19, lng: 6.61 }, { code: 'SV', lat: 13.79, lng: -88.90 },
  { code: 'SY', lat: 34.80, lng: 38.997 }, { code: 'SZ', lat: -26.52, lng: 31.47 },
  { code: 'TD', lat: 15.45, lng: 18.73 }, { code: 'TG', lat: 8.62, lng: 0.82 },
  { code: 'TH', lat: 15.87, lng: 100.99 }, { code: 'TJ', lat: 38.86, lng: 71.28 },
  { code: 'TL', lat: -8.87, lng: 125.73 }, { code: 'TM', lat: 38.97, lng: 59.56 },
  { code: 'TN', lat: 33.89, lng: 9.54 }, { code: 'TO', lat: -21.18, lng: -175.20 },
  { code: 'TR', lat: 38.96, lng: 35.24 }, { code: 'TT', lat: 10.69, lng: -61.22 },
  { code: 'TV', lat: -7.11, lng: 177.65 }, { code: 'TW', lat: 23.70, lng: 120.96 },
  { code: 'TZ', lat: -6.37, lng: 34.89 }, { code: 'UA', lat: 48.38, lng: 31.17 },
  { code: 'UG', lat: 1.37, lng: 32.29 }, { code: 'US', lat: 37.09, lng: -95.71 },
  { code: 'UY', lat: -32.52, lng: -55.77 }, { code: 'UZ', lat: 41.38, lng: 64.59 },
  { code: 'VA', lat: 41.90, lng: 12.45 }, { code: 'VC', lat: 13.25, lng: -61.20 },
  { code: 'VE', lat: 6.42, lng: -66.59 }, { code: 'VN', lat: 14.06, lng: 108.28 },
  { code: 'VU', lat: -15.38, lng: 166.96 }, { code: 'WS', lat: -13.76, lng: -172.10 },
  { code: 'YE', lat: 15.55, lng: 48.52 }, { code: 'ZA', lat: -30.56, lng: 22.94 },
  { code: 'ZM', lat: -13.13, lng: 27.85 }, { code: 'ZW', lat: -19.02, lng: 29.15 },
];

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));

export function isCountryCode(value: string): boolean {
  return COUNTRY_CODES.has(value.toUpperCase());
}

export function countryCentroid(code: string): CountryCentroid | undefined {
  return COUNTRIES.find((c) => c.code === code.toUpperCase());
}

// Regional-indicator-symbol trick: each letter A-Z maps to U+1F1E6..U+1F1FF,
// so e.g. "IT" becomes the two code points that render as 🇮🇹. No image
// assets needed.
export function flagEmoji(code: string): string {
  return code
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65));
}

export function countryDisplayName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}
