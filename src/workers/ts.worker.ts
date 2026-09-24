/**
 * TS worker (要件定義書 15): MPEG-TS demux, PSI/SI parsing and PES extraction.
 * Decoupled from the receiver so recorded TS can be analysed without a tuner.
 */
/// <reference lib="webworker" />
import { TransportStream } from '../ts/TransportStream'
import type { TsCommand, TsEvent, WorkerError } from './protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

function post(event: TsEvent, transfer?: Transferable[]): void {
  ctx.postMessage(event, transfer ?? [])
}

function postError(error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error))
  const payload: WorkerError = { message: e.message, stack: e.stack }
  post({ type: 'error', error: payload })
}

const transport = new TransportStream({
  onPat: (section) => post({ type: 'pat', section }),
  onPmt: (section) => post({ type: 'pmt', section }),
  onSdt: (section) => post({ type: 'sdt', section }),
  onEit: (section) => post({ type: 'eit', section }),
  onNit: (section) => post({ type: 'nit', section }),
  onTdt: (section) => post({ type: 'tdt', section }),
  onTot: (section) => post({ type: 'tot', section }),
  onPes: (packet) => {
    const copy = packet.data.slice()
    post({ type: 'pes', packet: { ...packet, data: copy } }, [copy.buffer])
  },
  onStatistics: (statistics) => post({ type: 'statistics', statistics }),
})

ctx.onmessage = (event: MessageEvent<TsCommand>) => {
  const command = event.data
  try {
    switch (command.type) {
      case 'input': {
        transport.push(new Uint8Array(command.data))
        break
      }
      case 'reset': {
        transport.reset()
        break
      }
      case 'selectService': {
        transport.selectService(command.serviceId)
        break
      }
    }
  } catch (error) {
    postError(error)
  }
}
