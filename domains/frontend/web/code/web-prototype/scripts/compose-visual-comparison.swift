#!/usr/bin/env swift

import AppKit
import Foundation

guard CommandLine.arguments.count == 5 else {
    fputs("usage: compose-visual-comparison.swift <reference.png> <actual.png> <output.png> <title>\n", stderr)
    exit(2)
}

let referencePath = CommandLine.arguments[1]
let actualPath = CommandLine.arguments[2]
let outputPath = CommandLine.arguments[3]
let title = CommandLine.arguments[4]

let outputURL = URL(fileURLWithPath: outputPath)
try FileManager.default.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
)

guard let reference = NSImage(contentsOfFile: referencePath),
      let actual = NSImage(contentsOfFile: actualPath) else {
    fputs("visual_comparison_image_unavailable\n", stderr)
    exit(1)
}

let panelWidth: CGFloat = 1100
let labelHeight: CGFloat = 58
let gap: CGFloat = 20
let referenceScale = panelWidth / reference.size.width
let actualScale = panelWidth / actual.size.width
let referenceHeight = reference.size.height * referenceScale
let actualHeight = actual.size.height * actualScale
let panelHeight = max(referenceHeight, actualHeight)
let canvasSize = NSSize(width: panelWidth * 2 + gap, height: panelHeight + labelHeight)

let canvas = NSImage(size: canvasSize)
canvas.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: canvasSize).fill()

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .left
let labelAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 18, weight: .semibold),
    .foregroundColor: NSColor(calibratedWhite: 0.12, alpha: 1),
    .paragraphStyle: paragraph,
]
let secondaryAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 14, weight: .regular),
    .foregroundColor: NSColor(calibratedWhite: 0.38, alpha: 1),
]

("Reference", labelAttributes).0.draw(at: NSPoint(x: 0, y: panelHeight + 29), withAttributes: labelAttributes)
("Implementation", labelAttributes).0.draw(at: NSPoint(x: panelWidth + gap, y: panelHeight + 29), withAttributes: labelAttributes)
title.draw(at: NSPoint(x: 0, y: panelHeight + 8), withAttributes: secondaryAttributes)

reference.draw(
    in: NSRect(x: 0, y: panelHeight - referenceHeight, width: panelWidth, height: referenceHeight),
    from: NSRect(origin: .zero, size: reference.size),
    operation: .copy,
    fraction: 1
)
actual.draw(
    in: NSRect(x: panelWidth + gap, y: panelHeight - actualHeight, width: panelWidth, height: actualHeight),
    from: NSRect(origin: .zero, size: actual.size),
    operation: .copy,
    fraction: 1
)

canvas.unlockFocus()

guard let tiff = canvas.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("visual_comparison_render_failed\n", stderr)
    exit(1)
}

try png.write(to: outputURL, options: .atomic)
print("visual_comparison=\(outputPath)")
