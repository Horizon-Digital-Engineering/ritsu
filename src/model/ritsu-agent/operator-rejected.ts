/** Thrown by a self-gated tool on rejection, so the call shows as an error
 *  while the model still gets the operator's message verbatim. */
export class OperatorRejected extends Error {
  name = 'OperatorRejected';
}
