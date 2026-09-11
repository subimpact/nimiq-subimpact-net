/**
 * GA4 events, pushed to the dataLayer the GTM snippet in Layout.astro creates.
 *
 * Nothing here throws: analytics must never be able to break a scan. If GTM is
 * blocked the array simply grows and is never read.
 */

type Params = Record<string, string | number | boolean | null | undefined>

interface DataLayerWindow extends Window {
  dataLayer?: Params[]
}

export function track(event: string, params: Params = {}): void {
  if (typeof window === "undefined") return
  const target = window as DataLayerWindow
  const layer = (target.dataLayer ??= [])
  layer.push({ event, ...params })
}
