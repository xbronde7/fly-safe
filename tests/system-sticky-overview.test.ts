import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const APP_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/App.tsx', import.meta.url)),
  'utf8'
)
const STYLES_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)),
  'utf8'
)

describe('pinned current-system overview', () => {
  it('keeps every live overview state inside the sticky region and long history outside it', () => {
    const { wrapper } = findStickyOverviewLayout(APP_SOURCE)
    const descendants = descendantClassNames(wrapper)

    expect(descendants).toEqual(expect.arrayContaining([
      'account-toolbar',
      'system-stale-notice',
      'system-unavailable-state',
      'system-intel-loading',
      'system-overview',
      'danger-reasons',
      'system-metrics'
    ]))
    expect(descendants).not.toEqual(expect.arrayContaining([
      'source-cap-notice',
      'historical-sightings',
      'system-refresh-stamp',
      'operational-intel-panels',
      'system-warning-list',
      'system-live-boundary'
    ]))
  })

  it('pins below the app bars with a foreground layer and an opaque surface', () => {
    const root = cssDeclarations(':root')
    const sticky = cssDeclarations('.system-sticky-overview')
    const zIndex = Number(cssProperty(sticky, 'z-index'))
    const background = resolveRootVariable(cssProperty(sticky, 'background'), root)

    expect(cssProperty(root, '--sticky-intel-top')).toBe('123px')
    expect(cssProperty(sticky, 'position')).toBe('sticky')
    expect(cssProperty(sticky, 'top')).toBe('var(--sticky-intel-top)')
    expect(zIndex).toBeGreaterThan(0)
    expect(background).not.toMatch(/\btransparent\b/i)
    expect(hasOpaqueColorLayer(background)).toBe(true)
  })

  it('is a direct root box through either JSX placement or explicit ancestor flattening', () => {
    const { root, wrapper } = findStickyOverviewLayout(APP_SOURCE)

    if (wrapper.parent === root) return

    const ancestors = jsxElementAncestors(wrapper, root)
    expect(ancestors).toHaveLength(2)
    expect(jsxClassNames(ancestors[0].openingElement)).toContain('connected-system')
    expect(jsxClassNames(ancestors[1].openingElement)).toContain('connected-layout')
    expect(cssRulesForClass('connected-system').map((rule) => cssProperty(rule, 'display')))
      .toContain('contents')
    expect(cssRulesForClass('connected-layout').map((rule) => cssProperty(rule, 'display')))
      .toContain('contents')
  })
})

function findStickyOverviewLayout(source: string): {
  root: ts.Expression
  wrapper: ts.JsxElement
} {
  const sourceFile = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const component = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'SystemIntelPanel'
  )
  if (!component?.body) throw new Error('SystemIntelPanel function not found')

  const returnStatement = component.body.statements.find(ts.isReturnStatement)
  let expression = returnStatement?.expression
  while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression
  if (!expression) throw new Error('SystemIntelPanel return expression not found')

  let wrapper: ts.JsxElement | undefined
  function visit(node: ts.Node): void {
    if (wrapper) return
    if (
      ts.isJsxElement(node) &&
      jsxClassNames(node.openingElement).includes('system-sticky-overview')
    ) {
      wrapper = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  if (!wrapper) throw new Error('system-sticky-overview element not found')
  return { root: expression, wrapper }
}

function jsxElementAncestors(node: ts.Node, root: ts.Node): ts.JsxElement[] {
  const result: ts.JsxElement[] = []
  let current = node.parent

  while (current) {
    if (ts.isJsxElement(current)) result.push(current)
    if (current === root) return result
    current = current.parent
  }

  throw new Error('Sticky overview is not contained by the component root')
}

function descendantClassNames(root: ts.JsxElement): string[] {
  const result = new Set<string>()

  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node)) {
      for (const className of jsxClassNames(node.openingElement)) result.add(className)
    } else if (ts.isJsxSelfClosingElement(node)) {
      for (const className of jsxClassNames(node)) result.add(className)
    }
    ts.forEachChild(node, visit)
  }

  for (const child of root.children) visit(child)
  return [...result]
}

function jsxClassNames(element: ts.JsxOpeningLikeElement): string[] {
  const attribute = element.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText() === 'className'
  )
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return []
  const fragments: string[] = []

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      fragments.push(node.text)
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(attribute.initializer)
  return fragments.flatMap((fragment) => fragment.split(/\s+/)).filter(Boolean)
}

function cssDeclarations(selector: string): string {
  for (const match of cssRuleMatches()) {
    const selectors = match[1].split(',').map((candidate) => candidate.trim())
    if (selectors.includes(selector)) return match[2]
  }
  throw new Error(`CSS rule not found: ${selector}`)
}

function cssRulesForClass(className: string): string[] {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const classPattern = new RegExp(`\\.${escaped}(?![\\w-])`)
  const result: string[] = []

  for (const match of cssRuleMatches()) {
    if (match[1].split(',').some((selector) => classPattern.test(selector))) result.push(match[2])
  }
  return result
}

function cssRuleMatches(): IterableIterator<RegExpMatchArray> {
  const source = STYLES_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
  return source.matchAll(/([^{}]+)\{([^{}]*)}/g)
}

function cssProperty(declarations: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return declarations.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`))?.[1].trim()
}

function resolveRootVariable(value: string | undefined, root: string): string {
  if (!value) throw new Error('Required CSS value is missing')
  const variable = value.match(/^var\((--[\w-]+)\)$/)?.[1]
  return variable ? cssProperty(root, variable) ?? value : value
}

function hasOpaqueColorLayer(value: string): boolean {
  if (/#[\da-f]{3}(?:[\da-f]{3})?(?![\da-f])/i.test(value)) return true
  if (/\brgb\((?![^)]*\/)[^)]*\)/i.test(value)) return true
  return /\brgba\([^)]*,\s*1(?:\.0+)?\s*\)/i.test(value)
}
