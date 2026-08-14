// A literal backslash, built without escapes so the source stays unambiguous.
const BS = String.fromCharCode(92);

/** Characters that must never appear raw inside an inline <script> block. */
const UNSAFE_IN_SCRIPT = {
  "<": BS + "u003c",
  "\u2028": BS + "u2028",
  "\u2029": BS + "u2029",
};

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/css/output.css");
  // Explicit globs so Google Drive's desktop.ini files stay out of the build.
  // Listing photos are NOT copied here — they live in R2 and are served from
  // /photos/ by the Worker (see worker/index.js and src/_data/photos.json).
  eleventyConfig.addPassthroughCopy({
    "src/assets/js/*.js": "assets/js",
    "src/assets/vendor/leaflet/*.{js,css}": "assets/vendor/leaflet",
    "src/assets/vendor/leaflet/images/*.png": "assets/vendor/leaflet/images",
    "src/assets/icons/*.png": "assets/icons",
    "src/manifest.webmanifest": "manifest.webmanifest",
    "src/robots.txt": "robots.txt",
    // Route geometries for the homepage drive lines — fetched lazily by
    // map-app.js, so they stay out of the inline page payload.
    "src/_data/routes.json": "assets/data/routes.json",
  });

  eleventyConfig.ignores.add("**/desktop.ini");

  /**
   * JSON that is safe to drop inside a <script> tag. A closing script tag or a
   * raw line separator inside a string would otherwise break the block.
   */
  eleventyConfig.addFilter("jsonScript", (value) => {
    let json = JSON.stringify(value === undefined ? null : value);
    for (const [char, escaped] of Object.entries(UNSAFE_IN_SCRIPT)) {
      json = json.split(char).join(escaped);
    }
    return json;
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      layouts: "_layouts",
    },
  };
};
