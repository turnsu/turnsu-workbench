import AppKit
import Foundation

guard CommandLine.arguments.count == 4 else {
  fputs("usage: compose-side-by-side reference.png actual.png output.png\n", stderr)
  exit(2)
}

let referencePath = CommandLine.arguments[1]
let actualPath = CommandLine.arguments[2]
let outputPath = CommandLine.arguments[3]

guard let reference = NSImage(contentsOfFile: referencePath),
      let actual = NSImage(contentsOfFile: actualPath) else {
  fputs("unable to read comparison input\n", stderr)
  exit(3)
}

let sourceWidth = max(reference.size.width, actual.size.width)
let sourceHeight = max(reference.size.height, actual.size.height)
let outputSize = NSSize(width: sourceWidth, height: sourceHeight / 2)
let halfWidth = outputSize.width / 2
let image = NSImage(size: outputSize)

image.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: outputSize).fill()
reference.draw(
  in: NSRect(x: 0, y: 0, width: halfWidth, height: outputSize.height),
  from: NSRect(origin: .zero, size: reference.size),
  operation: .copy,
  fraction: 1
)
actual.draw(
  in: NSRect(x: halfWidth, y: 0, width: halfWidth, height: outputSize.height),
  from: NSRect(origin: .zero, size: actual.size),
  operation: .copy,
  fraction: 1
)
image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
  fputs("unable to encode comparison output\n", stderr)
  exit(4)
}

try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
