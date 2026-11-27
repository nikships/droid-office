/** The shared contrast policy halves the target for dim ANSI. Even half must exceed black's contrast with the
 * brightest pane, so it lifts dark ink rather than darkening it over a transparent ground. */
export function minimumContrast(background) {
  return background.slice(7) === '00' ? 6 : 4.5;
}
