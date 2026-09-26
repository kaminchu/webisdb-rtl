/**
 * WebGPU flag values used by the OFDM front end.
 *
 * The TypeScript DOM lib ships the WebGPU interfaces but not the constant
 * namespaces (`GPUBufferUsage`, `GPUShaderStage`, `GPUMapMode`), so the subset
 * this project uses is declared here from the spec definitions.
 */

export const BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const

export const SHADER_STAGE = { COMPUTE: 0x0004 } as const

export const MAP_MODE = { READ: 0x0001 } as const
