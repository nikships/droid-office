// The roof of the building, over its top floor. Nobody works up there. The elevator goes up there
// from every floor. Shared by the server (who's up there) and the client (which builds it).

/**
 * Where you are while you're on the roof (a connection's `floor`, and `floor.go`'s). It can never be a
 * project floor's id, which is only ever lowercase letters, digits and dashes.
 */
export const ROOF = '@roof';
export const ROOF_NAME = 'Rooftop';
