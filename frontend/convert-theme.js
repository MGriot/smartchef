import fs from 'fs';

const cssMatch = /--([^:]+):\s*(#[a-fA-F0-9]{6});/g;
let cssContent = fs.readFileSync('src/theme.css', 'utf-8');

const hexToRgb = (hex) => {
    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);
    return `${r} ${g} ${b}`;
};

cssContent = cssContent.replace(cssMatch, (match, p1, p2) => {
    return `--${p1}: ${hexToRgb(p2)};`;
});

fs.writeFileSync('src/theme.css', cssContent);

let twContent = fs.readFileSync('tailwind.config.js', 'utf-8');
const twMatch = /"(.*?)":\s*"var\(--color-(.*?)\)"/g;
twContent = twContent.replace(twMatch, (match, p1, p2) => {
    return `"${p1}": "rgb(var(--color-${p2}) / <alpha-value>)"`;
});

fs.writeFileSync('tailwind.config.js', twContent);
console.log('Conversion complete');
