/**
 * Pick a glow color from album art.
 * Skips near-black / near-white pixels and favors saturated colors.
 */
export async function extractAlbumGlowColor(
  src: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = 48;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let weightSum = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 128) continue;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const lightness = (max + min) / 2 / 255;
        const saturation = max === 0 ? 0 : (max - min) / max;

        // Ignore washed-out and near-black pixels.
        if (lightness < 0.08 || lightness > 0.9 || saturation < 0.12) continue;

        const weight = saturation * (1 - Math.abs(lightness - 0.45));
        rSum += r * weight;
        gSum += g * weight;
        bSum += b * weight;
        weightSum += weight;
      }

      if (weightSum < 1e-6) {
        resolve(null);
        return;
      }

      const r = Math.round(rSum / weightSum);
      const g = Math.round(gSum / weightSum);
      const b = Math.round(bSum / weightSum);
      resolve(`rgb(${r}, ${g}, ${b})`);
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
