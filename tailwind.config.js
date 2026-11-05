/** @type {import('tailwindcss').Config} */
module.exports = {
  // Las clases también se arman en template strings de js/; el extractor de Tailwind
  // sólo detecta nombres completos y literales (nada de `bg-${color}-500`).
  content: ['./index.html', './js/**/*.js'],
  safelist: [],
  theme: {
    extend: {},
  },
  plugins: [],
};
