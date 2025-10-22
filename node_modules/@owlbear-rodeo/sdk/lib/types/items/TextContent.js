export function isFormattedText(descendant) {
    return "text" in descendant;
}
export function isElement(descendant) {
    return "children" in descendant;
}
