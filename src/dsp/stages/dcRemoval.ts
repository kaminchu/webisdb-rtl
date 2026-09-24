/**
 * DC offset removal via a one-pole running mean (complex high-pass).
 *
 * dc[n] = dc[n-1] + alpha * (x[n] - dc[n-1]); y[n] = x[n] - dc[n].
 */

export function removeDc(re: Float32Array, im: Float32Array, alpha = 0.001): void {
  let dcRe = 0
  let dcIm = 0
  for (let i = 0; i < re.length; i++) {
    dcRe += alpha * (re[i] - dcRe)
    dcIm += alpha * (im[i] - dcIm)
    re[i] -= dcRe
    im[i] -= dcIm
  }
}

export class DcRemoval {
  private readonly alpha: number
  private dcRe = 0
  private dcIm = 0

  constructor(alpha = 0.001) {
    this.alpha = alpha
  }

  process(re: Float32Array, im: Float32Array): void {
    const alpha = this.alpha
    let dcRe = this.dcRe
    let dcIm = this.dcIm
    for (let i = 0; i < re.length; i++) {
      dcRe += alpha * (re[i] - dcRe)
      dcIm += alpha * (im[i] - dcIm)
      re[i] -= dcRe
      im[i] -= dcIm
    }
    this.dcRe = dcRe
    this.dcIm = dcIm
  }

  reset(): void {
    this.dcRe = 0
    this.dcIm = 0
  }
}
