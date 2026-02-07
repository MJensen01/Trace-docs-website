module.exports = {
  currentVersion: "1.0.4",
  downloadBaseUrl: "https://download.trace-docs.com",

  platformAssets: {
    windows: {
      label: "Windows",
      icon: "W:",
      fileName: "Trace-1.0.4-Setup.exe",
      fileSize: "48.2 MB",
      sha256: "a1b2c3d4e5f6...replace-with-real-checksum",
      arch: "x64",
    },
    macos: {
      label: "macOS",
      icon: "$",
      fileName: "Trace-1.0.4.dmg",
      fileSize: "52.1 MB",
      sha256: "f6e5d4c3b2a1...replace-with-real-checksum",
      arch: "Universal (Intel + Apple Silicon)",
    },
    linux: {
      label: "Linux",
      icon: "#",
      fileName: "trace-1.0.4-amd64.deb",
      fileSize: "44.7 MB",
      sha256: "9a8b7c6d5e4f...replace-with-real-checksum",
      arch: "amd64 (.deb)",
    },
  },

  get downloadUrls() {
    const base = this.downloadBaseUrl;
    return {
      windows: `${base}/${this.platformAssets.windows.fileName}`,
      macos: `${base}/${this.platformAssets.macos.fileName}`,
      linux: `${base}/${this.platformAssets.linux.fileName}`,
    };
  },
};
