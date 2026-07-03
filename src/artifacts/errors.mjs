export function statusForError(error) {
  return error.statusCode || 500
}

export function publicError(publicCode, publicMessage, statusCode) {
  const error = new Error(publicMessage)
  error.publicCode = publicCode
  error.publicMessage = publicMessage
  error.statusCode = statusCode
  return error
}
