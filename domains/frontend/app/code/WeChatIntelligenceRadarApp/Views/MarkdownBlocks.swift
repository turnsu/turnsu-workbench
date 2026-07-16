import Foundation
import SwiftUI

// MARK: - Block model

/// A parsed markdown block. Intentionally small — agent output is headings, bullets, numbered
/// items, fenced code and paragraphs. Anything we can't classify stays a paragraph.
enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case bullet(text: String)
    case ordered(marker: String, text: String)
    case code(text: String)
    case table(header: [String], rows: [[String]])
    case paragraph(text: String)
    case rule
}

// MARK: - Parser

/// Best-effort markdown parser tuned for the *compact* markdown agents emit (block markers often
/// glued together with no surrounding newlines). It normalizes obvious block boundaries, then
/// classifies line-by-line. It never throws and never drops text — unclassified content becomes
/// a paragraph, so the worst case is "looks like the old plain text".
enum MarkdownParser {
    static func parse(_ raw: String) -> [MarkdownBlock] {
        let normalized = normalize(AgentOutputCopy.normalizedMarkdown(raw))
        var blocks: [MarkdownBlock] = []
        var paragraphBuffer: [String] = []
        var inCode = false
        var codeBuffer: [String] = []
        var tableBuffer: [String] = []

        func flushParagraph() {
            let joined = paragraphBuffer.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !joined.isEmpty { blocks.append(.paragraph(text: joined)) }
            paragraphBuffer.removeAll()
        }
        func flushTable() {
            defer { tableBuffer.removeAll() }
            let rows = tableBuffer
                .map(tableCells)
                .filter { !isSeparatorRow($0) && !$0.allSatisfy(\.isEmpty) }
            guard let header = rows.first else { return }
            blocks.append(.table(header: header, rows: Array(rows.dropFirst())))
        }

        for rawLine in normalized.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)

            // Fenced code blocks.
            if line.hasPrefix("```") {
                if inCode {
                    blocks.append(.code(text: codeBuffer.joined(separator: "\n")))
                    codeBuffer.removeAll()
                    inCode = false
                } else {
                    flushParagraph(); flushTable()
                    inCode = true
                }
                continue
            }
            if inCode { codeBuffer.append(rawLine); continue }

            // Table rows accumulate until a non-table line appears.
            if isTableRow(line) {
                flushParagraph(); tableBuffer.append(line); continue
            } else if !tableBuffer.isEmpty {
                flushTable()
            }

            if line.isEmpty { flushParagraph(); continue }

            // Horizontal rule.
            if line.allSatisfy({ $0 == "-" }) && line.count >= 3 {
                flushParagraph(); blocks.append(.rule); continue
            }

            // Heading: #..###### then text. If a heading has a whole sentence glued after an
            // em-dash (e.g. "1.BTC—比特币 …长正文"), keep a concise title and demote the rest
            // to a paragraph so we don't style a whole blob as a heading.
            if case .heading(let level, let text)? = headingMatch(line) {
                flushParagraph()
                if let sep = text.range(of: "—"), text.count > 14 {
                    let title = String(text[..<sep.lowerBound]).trimmingCharacters(in: .whitespaces)
                    let rest = String(text[sep.upperBound...]).trimmingCharacters(in: .whitespaces)
                    blocks.append(.heading(level: level, text: title.isEmpty ? text : title))
                    if !title.isEmpty, !rest.isEmpty { blocks.append(.paragraph(text: rest)) }
                } else {
                    blocks.append(.heading(level: level, text: text))
                }
                continue
            }

            // Bullet: "- text" / "* text" / "-**text**" / compact CJK "-市场概览".
            if let bullet = bulletMatch(line) {
                flushParagraph(); blocks.append(.bullet(text: bullet)); continue
            }

            // Ordered: "1. text" / "1) text".
            if let ordered = orderedMatch(line) {
                flushParagraph(); blocks.append(ordered); continue
            }

            paragraphBuffer.append(line)
        }
        if inCode, !codeBuffer.isEmpty { blocks.append(.code(text: codeBuffer.joined(separator: "\n"))) }
        flushTable()
        flushParagraph()
        return blocks
    }

    // MARK: Table helpers

    /// A line is a table row when it is pipe-delimited: starts with "|" or has ≥2 pipes.
    private static func isTableRow(_ line: String) -> Bool {
        guard line.contains("|") else { return false }
        return line.hasPrefix("|") || line.filter { $0 == "|" }.count >= 2
    }

    private static func tableCells(_ line: String) -> [String] {
        var s = line
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// Separator row like `| --- | :--: |` — cells made only of dashes/colons/spaces.
    private static func isSeparatorRow(_ cells: [String]) -> Bool {
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            !cell.isEmpty && cell.contains("-") && cell.allSatisfy { "-: ".contains($0) }
        }
    }

    /// Insert newline boundaries before glued block markers so the line scanner can see them.
    /// (We do NOT inject spaces after the #'s — `headingMatch` drops the #'s and trims, so a
    /// glued "###一" parses correctly. Injecting spaces previously corrupted the level/text.)
    private static func normalize(_ raw: String) -> String {
        var s = raw
        // Horizontal rules: a glued "---" → own line. BUT not table-separator dashes
        // ("| --- |"): skip when preceded by space/pipe or followed by spaces-then-pipe.
        s = replace(s, pattern: "(?<![ \\t|])-{3,}(?!\\s*\\|)", with: "\n---\n")
        // Heading run glued to preceding text: "…text###X" → newline before the #'s.
        // Exclude '#' from the preceding char so a run like "###" is never split mid-run.
        s = replace(s, pattern: "([^\\n#])(#{1,6})(?=\\S)", with: "$1\n$2")
        // Sub-bullets of the form " -**bold**" that appear inline → own line.
        s = replace(s, pattern: "(?<=\\S)\\s-(?=\\*\\*)", with: "\n- ")
        return s
    }

    private static func headingMatch(_ line: String) -> MarkdownBlock? {
        guard line.hasPrefix("#") else { return nil }
        var level = 0
        for ch in line { if ch == "#" { level += 1 } else { break } }
        guard (1...6).contains(level) else { return nil }
        let text = String(line.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return .heading(level: level, text: text)
    }

    private static func bulletMatch(_ line: String) -> String? {
        if line.hasPrefix("- ") || line.hasPrefix("* ") {
            return String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        }
        if line.hasPrefix("-**") || line.hasPrefix("•") {
            return String(line.dropFirst(1)).trimmingCharacters(in: .whitespaces)
        }
        if line.range(of: #"^-\S+[:：]"#, options: .regularExpression) != nil {
            return String(line.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private static func orderedMatch(_ line: String) -> MarkdownBlock? {
        // "1. text", "1) text", or compact CJK output like "1.保留".
        guard let range = line.range(of: "^\\d{1,3}[.)]\\s*", options: .regularExpression) else { return nil }
        let marker = String(line[range]).trimmingCharacters(in: .whitespaces)
        let text = String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return .ordered(marker: marker, text: text)
    }

    private static func replace(_ s: String, pattern: String, with template: String,
                                options: NSRegularExpression.Options = []) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return s }
        let range = NSRange(s.startIndex..., in: s)
        return regex.stringByReplacingMatches(in: s, options: [], range: range, withTemplate: template)
    }
}

// MARK: - Inline rendering

/// Render one line of inline markdown (**bold**, `code`, *italic*) via AttributedString.
/// Falls back to plain text if parsing fails — never blank.
struct InlineMarkdownText: View {
    let text: String
    var size: CGFloat = 12
    var weight: Font.Weight = .regular
    var color: Color = RadarTheme.primaryText

    var body: some View {
        Text(attributed)
            .font(.system(size: size, weight: weight))
            .foregroundStyle(color)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var attributed: AttributedString {
        if let parsed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return parsed
        }
        return AttributedString(text)
    }
}

// MARK: - Block view

/// Renders agent markdown as readable blocks. The single drop-in replacement for `Text(raw)`.
struct MarkdownBlocksView: View {
    let raw: String
    var baseSize: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(MarkdownBlockParseCache.blocks(for: raw).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            InlineMarkdownText(
                text: text,
                size: headingSize(level),
                weight: level <= 2 ? .bold : .semibold,
                color: RadarTheme.primaryText
            )
            .padding(.top, level <= 2 ? 4 : 2)

        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Circle()
                    .fill(RadarTheme.blue)
                    .frame(width: 4, height: 4)
                    .offset(y: -1)
                InlineMarkdownText(text: text, size: baseSize, color: RadarTheme.secondaryText)
            }

        case .ordered(let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(marker)
                    .font(.system(size: baseSize, weight: .bold, design: .rounded))
                    .foregroundStyle(RadarTheme.blue)
                InlineMarkdownText(text: text, size: baseSize, color: RadarTheme.secondaryText)
            }

        case .code(let text):
            Text(text)
                .font(.system(size: baseSize - 0.5, design: .monospaced))
                .foregroundStyle(RadarTheme.primaryText)
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RadarTheme.tintFaint)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .textSelection(.enabled)

        case .table(let header, let rows):
            let columnCount = max(header.count, rows.map(\.count).max() ?? 0)
            let columnWidth = tableColumnWidth(columnCount)
            ScrollView(.horizontal, showsIndicators: true) {
                VStack(spacing: 0) {
                    tableRowView(header, columnCount: columnCount, columnWidth: columnWidth, isHeader: true)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        Divider().overlay(RadarTheme.borderSoft)
                        tableRowView(row, columnCount: columnCount, columnWidth: columnWidth, isHeader: false)
                    }
                }
                .frame(minWidth: CGFloat(max(columnCount, 1)) * columnWidth, alignment: .leading)
            }
            .background(RadarTheme.tintFaint)
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

        case .paragraph(let text):
            InlineMarkdownText(text: text, size: baseSize, color: RadarTheme.primaryText)

        case .rule:
            Divider().overlay(RadarTheme.borderSoft).padding(.vertical, 2)
        }
    }

    private func tableRowView(_ cells: [String], columnCount: Int, columnWidth: CGFloat, isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(0..<max(columnCount, 1), id: \.self) { index in
                let cell = index < cells.count ? cells[index] : ""
                InlineMarkdownText(
                    text: cell,
                    size: baseSize - 0.5,
                    weight: isHeader ? .semibold : .regular,
                    color: isHeader ? RadarTheme.primaryText : RadarTheme.secondaryText
                )
                .frame(width: columnWidth, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(isHeader ? RadarTheme.tintSoft : Color.clear)
    }

    private func tableColumnWidth(_ columnCount: Int) -> CGFloat {
        switch columnCount {
        case 0...2: return 190
        case 3...4: return 160
        case 5...7: return 138
        default: return 126
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return baseSize + 6
        case 2: return baseSize + 4
        case 3: return baseSize + 2
        default: return baseSize + 1
        }
    }
}

private final class MarkdownBlockCacheBox {
    let blocks: [MarkdownBlock]

    init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }
}

@MainActor
private enum MarkdownBlockParseCache {
    private static let cache = NSCache<NSString, MarkdownBlockCacheBox>()

    static func blocks(for raw: String) -> [MarkdownBlock] {
        let key = raw as NSString
        if let cached = cache.object(forKey: key) {
            return cached.blocks
        }
        let parsed = MarkdownParser.parse(raw)
        cache.setObject(MarkdownBlockCacheBox(blocks: parsed), forKey: key)
        return parsed
    }
}
