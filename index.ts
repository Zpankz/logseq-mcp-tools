import * as dotenv from 'dotenv'

dotenv.config()

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {z} from 'zod'

// ============================================================================
// Configuration
// ============================================================================

const LOGSEQ_TOKEN = process.env.LOGSEQ_TOKEN
const LOGSEQ_HOST = process.env.LOGSEQ_HOST ?? '127.0.0.1'
const LOGSEQ_PORT = process.env.LOGSEQ_PORT ?? '12315'
const LOGSEQ_API_URL = process.env.LOGSEQ_API_URL ?? `http://${LOGSEQ_HOST}:${LOGSEQ_PORT}/api`

const server = new McpServer({
    name: 'Logseq Tools',
    version: '2.0.0',
})

// ============================================================================
// Helper Functions
// ============================================================================

/** Make API calls to Logseq HTTP API */
async function callLogseqApi(method: string, args: any[] = []): Promise<any> {
    const response = await fetch(LOGSEQ_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${LOGSEQ_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({method, args}),
    })

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error(
                `Logseq API authentication failed (401 Unauthorized). ` +
                `Please verify:\n` +
                `1. The HTTP API is enabled in Logseq (Settings > Features > HTTP APIs Server)\n` +
                `2. Your token matches the one in Logseq's "Authorization token" setting\n` +
                `3. Logseq is running and accessible at ${LOGSEQ_API_URL}`
            )
        }
        throw new Error(`Logseq API error: ${response.status} ${response.statusText}`)
    }

    return response.json()
}

/** Format date for Logseq journal page names (e.g., "mar 14th, 2025") */
function formatJournalDate(date: Date): string {
    const month = date.toLocaleString('en-US', {month: 'short'}).toLowerCase()
    const day = date.getDate()
    const year = date.getFullYear()
    const suffix = (day >= 11 && day <= 13) ? 'th' : ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][day % 10]
    return `${month} ${day}${suffix}, ${year}`
}

/** Process blocks tree into readable text */
function processBlocks(blocks: any[], indent = 0): string {
    let text = ''
    for (const block of blocks) {
        if (block.content) {
            text += `${'  '.repeat(indent)}- ${block.content}\n`
            if (block.children?.length > 0) {
                text += processBlocks(block.children, indent + 1)
            }
        }
    }
    return text
}

/** Parse natural language date range */
function parseDateRange(dateRange: string): {start: Date; end: Date; title: string} {
    const today = new Date()
    const end = new Date(today)
    end.setHours(23, 59, 59, 999)
    let start = new Date(today)
    let title = ''

    const ranges: Record<string, () => void> = {
        'today': () => { start.setHours(0, 0, 0, 0); title = "Today's Journal" },
        'yesterday': () => {
            start.setDate(today.getDate() - 1); start.setHours(0, 0, 0, 0)
            end.setDate(today.getDate() - 1); title = "Yesterday's Journal"
        },
        'this week': () => {
            start.setDate(today.getDate() - today.getDay()); start.setHours(0, 0, 0, 0)
            title = 'This Week\'s Journal'
        },
        'last week': () => {
            start.setDate(today.getDate() - today.getDay() - 7); start.setHours(0, 0, 0, 0)
            end.setDate(today.getDate() - today.getDay() - 1); end.setHours(23, 59, 59, 999)
            title = 'Last Week\'s Journal'
        },
        'this month': () => {
            start.setDate(1); start.setHours(0, 0, 0, 0)
            title = `Journal for ${today.toLocaleString('en-US', {month: 'long'})} ${today.getFullYear()}`
        },
        'last month': () => {
            start.setMonth(today.getMonth() - 1, 1); start.setHours(0, 0, 0, 0)
            end.setDate(0)
            title = `Journal for ${start.toLocaleString('en-US', {month: 'long'})} ${start.getFullYear()}`
        },
        'last 7 days': () => {
            start.setDate(today.getDate() - 7); start.setHours(0, 0, 0, 0)
            title = 'Last 7 Days Journal'
        },
        'last 30 days': () => {
            start.setDate(today.getDate() - 30); start.setHours(0, 0, 0, 0)
            title = 'Last 30 Days Journal'
        },
    }

    const normalizedRange = dateRange.toLowerCase().trim()
    if (ranges[normalizedRange]) {
        ranges[normalizedRange]()
    } else {
        // Default to this week
        start.setDate(today.getDate() - today.getDay()); start.setHours(0, 0, 0, 0)
        title = 'Weekly Journal'
    }

    return {start, end, title}
}

/** Build common Datalog query patterns */
function buildDatalogQuery(queryType: string, params: Record<string, any> = {}): string {
    const queries: Record<string, string> = {
        // Find all pages with optional property filter
        'pages': `[:find (pull ?p [*]) :where [?p :block/name]]`,

        // Find pages by property value
        'pages_with_property': `[:find (pull ?p [*]) :where [?p :block/properties ?props] [(get ?props :${params.property}) ?v] [(= ?v "${params.value}")]]`,

        // Find all blocks with TODO markers
        'todos': `[:find (pull ?b [*]) :where [?b :block/marker ?m] [(contains? #{"TODO" "DOING" "NOW" "LATER" "WAITING"} ?m)]]`,

        // Find blocks containing specific text
        'blocks_with_text': `[:find (pull ?b [*]) :where [?b :block/content ?c] [(clojure.string/includes? ?c "${params.text}")]]`,

        // Find pages by tag
        'pages_with_tag': `[:find (pull ?p [*]) :where [?p :block/tags ?t] [?t :block/name "${params.tag?.toLowerCase()}"]]`,

        // Find blocks by tag
        'blocks_with_tag': `[:find (pull ?b [*]) :where [?b :block/refs ?r] [?r :block/name "${params.tag?.toLowerCase()}"]]`,

        // Find all journal pages
        'journals': `[:find (pull ?p [*]) :where [?p :block/journal? true]]`,

        // Find recently modified pages
        'recent_pages': `[:find (pull ?p [*]) :where [?p :block/updated-at ?t] [(> ?t ${Date.now() - (params.days || 7) * 86400000})]]`,

        // Find orphan pages (no backlinks)
        'orphan_pages': `[:find (pull ?p [*]) :where [?p :block/name] (not [?b :block/refs ?p])]`,

        // Find pages linking to a specific page
        'backlinks': `[:find (pull ?p [*]) :where [?b :block/refs ?target] [?target :block/name "${params.page?.toLowerCase()}"] [?b :block/page ?p]]`,
    }

    return queries[queryType] || params.custom || queries['pages']
}

// ============================================================================
// Tool 1: logseq_query - Unified Query Interface
// ============================================================================

server.tool(
    'logseq_query',
    {
        mode: z.enum(['pages', 'blocks', 'datalog', 'search', 'todos', 'journals', 'backlinks', 'recent'])
            .describe('Query mode: pages (list/filter pages), blocks (search block content), datalog (raw Datalog query), search (text search), todos (find tasks), journals (journal entries), backlinks (pages linking to target), recent (recently modified)'),

        query: z.string().optional()
            .describe('Search text, page name, tag name, or raw Datalog query depending on mode'),

        filters: z.object({
            tag: z.string().optional().describe('Filter by tag name'),
            property: z.string().optional().describe('Property name to filter by'),
            propertyValue: z.string().optional().describe('Property value to match'),
            dateRange: z.string().optional().describe('For journals: "today", "this week", "last 7 days", etc.'),
            journalOnly: z.boolean().optional().describe('Only include journal pages'),
            limit: z.number().optional().describe('Max results to return'),
        }).optional().describe('Optional filters to narrow results'),

        output: z.enum(['full', 'summary', 'names']).optional()
            .describe('Output format: full (all data), summary (condensed), names (just page/block names)'),
    },
    async ({mode, query, filters, output = 'summary'}) => {
        try {
            let results: any[] = []
            let datalogQuery: string

            switch (mode) {
                case 'pages':
                    if (filters?.tag) {
                        datalogQuery = buildDatalogQuery('pages_with_tag', {tag: filters.tag})
                        results = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])
                    } else if (filters?.property && filters?.propertyValue) {
                        datalogQuery = buildDatalogQuery('pages_with_property', {
                            property: filters.property,
                            value: filters.propertyValue
                        })
                        results = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])
                    } else {
                        // Get all pages and filter client-side if query provided
                        const allPages = await callLogseqApi('logseq.Editor.getAllPages')
                        results = query
                            ? allPages.filter((p: any) => p.name?.toLowerCase().includes(query.toLowerCase()))
                            : allPages
                    }

                    // Apply journal filter
                    if (filters?.journalOnly) {
                        results = results.filter((p: any) => p['journal?'] === true || p[0]?.['block/journal?'])
                    }
                    break

                case 'blocks':
                    if (query) {
                        datalogQuery = buildDatalogQuery('blocks_with_text', {text: query})
                        results = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])
                    } else if (filters?.tag) {
                        datalogQuery = buildDatalogQuery('blocks_with_tag', {tag: filters.tag})
                        results = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])
                    }
                    break

                case 'todos':
                    datalogQuery = buildDatalogQuery('todos')
                    results = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])
                    break

                case 'journals':
                    const {start, end, title} = parseDateRange(filters?.dateRange || 'this week')
                    datalogQuery = buildDatalogQuery('journals')
                    const allJournals = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])

                    // Filter by date range
                    results = allJournals.filter((j: any) => {
                        const page = j[0] || j
                        const journalDay = page['block/journal-day'] || page.journalDay
                        if (!journalDay) return false
                        // journalDay format: 20250314 (YYYYMMDD)
                        const year = Math.floor(journalDay / 10000)
                        const month = Math.floor((journalDay % 10000) / 100) - 1
                        const day = journalDay % 100
                        const pageDate = new Date(year, month, day)
                        return pageDate >= start && pageDate <= end
                    })
                    break

                case 'backlinks':
                    if (!query) {
                        return {content: [{type: 'text', text: 'Error: backlinks mode requires a page name in the query parameter'}]}
                    }
                    // Use efficient API call instead of iterating all pages
                    try {
                        const linkedRefs = await callLogseqApi('logseq.Editor.getPageLinkedReferences', [query])
                        results = linkedRefs || []
                    } catch {
                        // Fallback to Datalog query
                        datalogQuery = buildDatalogQuery('backlinks', {page: query})
                        results = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])
                    }
                    break

                case 'recent':
                    datalogQuery = buildDatalogQuery('recent_pages', {days: 7})
                    results = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])
                    break

                case 'search':
                    if (!query) {
                        return {content: [{type: 'text', text: 'Error: search mode requires a query'}]}
                    }
                    // Use block search for full-text
                    datalogQuery = buildDatalogQuery('blocks_with_text', {text: query})
                    results = await callLogseqApi('logseq.DB.datascriptQuery', [datalogQuery])
                    break

                case 'datalog':
                    if (!query) {
                        return {content: [{type: 'text', text: 'Error: datalog mode requires a Datalog query string'}]}
                    }
                    results = await callLogseqApi('logseq.DB.datascriptQuery', [query])
                    break
            }

            // Apply limit
            if (filters?.limit && results.length > filters.limit) {
                results = results.slice(0, filters.limit)
            }

            // Format output
            let outputText: string

            if (output === 'names') {
                const names = results.map((r: any) => {
                    const item = r[0] || r
                    return item['block/name'] || item['block/original-name'] || item.name || item.originalName || item.content?.substring(0, 50) || 'Unknown'
                })
                outputText = names.join('\n')
            } else if (output === 'summary') {
                outputText = `Found ${results.length} results:\n\n`
                results.slice(0, 20).forEach((r: any, i: number) => {
                    const item = r[0] || r
                    const name = item['block/name'] || item['block/original-name'] || item.name || item.originalName || ''
                    const content = item['block/content'] || item.content || ''
                    const marker = item['block/marker'] || item.marker || ''

                    if (name) outputText += `${i + 1}. [[${name}]]`
                    if (marker) outputText += ` [${marker}]`
                    if (content && !name) outputText += `${i + 1}. ${content.substring(0, 100)}...`
                    outputText += '\n'
                })
                if (results.length > 20) outputText += `\n... and ${results.length - 20} more results`
            } else {
                outputText = JSON.stringify(results, null, 2)
            }

            return {content: [{type: 'text', text: outputText}]}
        } catch (error: any) {
            return {content: [{type: 'text', text: `Query error: ${error.message}`}]}
        }
    }
)

// ============================================================================
// Tool 2: logseq_read - Unified Read Interface
// ============================================================================

server.tool(
    'logseq_read',
    {
        target: z.enum(['page', 'block', 'journal'])
            .describe('What to read: page (by name), block (by UUID), journal (by date or range)'),

        identifier: z.string()
            .describe('Page name, block UUID, or date/range for journals (e.g., "today", "2025-03-14", "this week")'),

        options: z.object({
            includeContent: z.boolean().optional().describe('Include full block content tree (default: true)'),
            includeBacklinks: z.boolean().optional().describe('Include pages that link to this page'),
            includeProperties: z.boolean().optional().describe('Include page/block properties'),
            depth: z.number().optional().describe('Max depth for nested blocks (default: unlimited)'),
        }).optional(),
    },
    async ({target, identifier, options = {}}) => {
        try {
            const {includeContent = true, includeBacklinks = false, includeProperties = true, depth} = options
            let output = ''

            switch (target) {
                case 'page': {
                    const page = await callLogseqApi('logseq.Editor.getPage', [identifier])
                    if (!page) {
                        return {content: [{type: 'text', text: `Page "${identifier}" not found.`}]}
                    }

                    output = `# ${page.originalName || page.name}\n\n`

                    // Properties
                    if (includeProperties && page.properties) {
                        output += `## Properties\n`
                        for (const [key, value] of Object.entries(page.properties)) {
                            output += `- ${key}:: ${value}\n`
                        }
                        output += '\n'
                    }

                    // Content
                    if (includeContent) {
                        const blocks = await callLogseqApi('logseq.Editor.getPageBlocksTree', [identifier])
                        if (blocks?.length > 0) {
                            output += `## Content\n\n`
                            output += processBlocks(blocks, 0)
                        }
                    }

                    // Backlinks (efficient API call)
                    if (includeBacklinks) {
                        try {
                            const refs = await callLogseqApi('logseq.Editor.getPageLinkedReferences', [identifier])
                            if (refs?.length > 0) {
                                output += `\n## Backlinks (${refs.length})\n\n`
                                refs.slice(0, 20).forEach((ref: any) => {
                                    const refPage = ref[0]
                                    const pageName = refPage?.['block/original-name'] || refPage?.['block/name'] || 'Unknown'
                                    output += `- [[${pageName}]]\n`
                                })
                                if (refs.length > 20) output += `- ... and ${refs.length - 20} more\n`
                            } else {
                                output += '\n## Backlinks\n\nNo backlinks found.\n'
                            }
                        } catch {
                            output += '\n## Backlinks\n\nCould not fetch backlinks.\n'
                        }
                    }
                    break
                }

                case 'block': {
                    // Clean block ID (remove (( )) if present)
                    const blockId = identifier.replace(/^\(\(|\)\)$/g, '')
                    const block = await callLogseqApi('logseq.Editor.getBlock', [blockId, {includeChildren: true}])

                    if (!block) {
                        return {content: [{type: 'text', text: `Block "${blockId}" not found.`}]}
                    }

                    output = `## Block: ${blockId.substring(0, 8)}...\n\n`
                    output += `**Content:** ${block.content}\n`

                    if (block.marker) output += `**Status:** ${block.marker}\n`
                    if (block.priority) output += `**Priority:** ${block.priority}\n`

                    if (includeProperties && block.properties) {
                        output += `\n### Properties\n`
                        for (const [key, value] of Object.entries(block.properties)) {
                            output += `- ${key}:: ${value}\n`
                        }
                    }

                    if (includeContent && block.children?.length > 0) {
                        output += `\n### Children\n\n`
                        output += processBlocks(block.children, 0)
                    }
                    break
                }

                case 'journal': {
                    const {start, end, title} = parseDateRange(identifier)

                    // Get all pages and filter for journals in range
                    const pages = await callLogseqApi('logseq.Editor.getAllPages')
                    const journalPages = pages.filter((p: any) => {
                        if (!p['journal?']) return false
                        const journalDay = p.journalDay
                        if (!journalDay) return false
                        const year = Math.floor(journalDay / 10000)
                        const month = Math.floor((journalDay % 10000) / 100) - 1
                        const day = journalDay % 100
                        const pageDate = new Date(year, month, day)
                        return pageDate >= start && pageDate <= end
                    }).sort((a: any, b: any) => b.journalDay - a.journalDay) // Most recent first

                    output = `# ${title}\n\n`
                    output += `*${start.toLocaleDateString()} - ${end.toLocaleDateString()}*\n\n`

                    if (journalPages.length === 0) {
                        output += 'No journal entries found for this period.\n'
                    } else {
                        // Track referenced pages for summary
                        const pageRefs: Record<string, number> = {}
                        const linkRegex = /\[\[(.*?)\]\]/g

                        for (const page of journalPages) {
                            output += `## ${page.originalName}\n\n`

                            if (includeContent) {
                                const blocks = await callLogseqApi('logseq.Editor.getPageBlocksTree', [page.name])
                                const blockText = processBlocks(blocks || [], 0)
                                output += blockText + '\n'

                                // Track page references
                                let match
                                while ((match = linkRegex.exec(blockText)) !== null) {
                                    const refPage = match[1]
                                    pageRefs[refPage] = (pageRefs[refPage] || 0) + 1
                                }
                            }
                        }

                        // Add referenced pages summary
                        const refEntries = Object.entries(pageRefs).sort((a, b) => b[1] - a[1])
                        if (refEntries.length > 0) {
                            output += `\n## Top Referenced Pages\n\n`
                            refEntries.slice(0, 10).forEach(([name, count]) => {
                                output += `- [[${name}]] (${count}x)\n`
                            })
                        }
                    }
                    break
                }
            }

            return {content: [{type: 'text', text: output}]}
        } catch (error: any) {
            return {content: [{type: 'text', text: `Read error: ${error.message}`}]}
        }
    }
)

// ============================================================================
// Tool 3: logseq_write - Unified Write Interface
// ============================================================================

server.tool(
    'logseq_write',
    {
        operation: z.enum([
            'create_page', 'delete_page',
            'create_block', 'update_block', 'delete_block',
            'append_to_page', 'append_to_journal',
            'set_property', 'remove_property'
        ]).describe('Write operation to perform'),

        target: z.string()
            .describe('Target page name, block UUID, or "today"/"yesterday" for journal operations'),

        content: z.string().optional()
            .describe('Content for the page/block (required for create/update/append operations)'),

        properties: z.record(z.any()).optional()
            .describe('Properties to set on page or block (key-value pairs)'),

        options: z.object({
            asJournal: z.boolean().optional().describe('Create page as journal entry'),
            parentBlockId: z.string().optional().describe('Parent block UUID for inserting nested blocks'),
            position: z.enum(['first', 'last']).optional().describe('Where to insert: first or last child'),
        }).optional(),
    },
    async ({operation, target, content, properties, options = {}}) => {
        try {
            let result = ''

            switch (operation) {
                case 'create_page': {
                    const pageProps = {...(properties || {})}
                    if (options.asJournal) {
                        pageProps['journal?'] = true
                    }

                    // Check if page exists
                    const existing = await callLogseqApi('logseq.Editor.getPage', [target])
                    if (existing) {
                        return {content: [{type: 'text', text: `Page "${target}" already exists. Use append_to_page to add content.`}]}
                    }

                    await callLogseqApi('logseq.Editor.createPage', [target, pageProps])

                    if (content) {
                        const lines = content.split('\n').filter(l => l.trim())
                        for (const line of lines) {
                            await callLogseqApi('logseq.Editor.appendBlockInPage', [target, line])
                        }
                    }

                    result = `Page "${target}" created successfully.`
                    break
                }

                case 'delete_page': {
                    await callLogseqApi('logseq.Editor.deletePage', [target])
                    result = `Page "${target}" deleted.`
                    break
                }

                case 'create_block': {
                    if (!content) {
                        return {content: [{type: 'text', text: 'Error: content is required for create_block'}]}
                    }

                    let blockRef: any
                    if (options.parentBlockId) {
                        // Insert as child of existing block
                        const parentId = options.parentBlockId.replace(/^\(\(|\)\)$/g, '')
                        blockRef = await callLogseqApi('logseq.Editor.insertBlock', [
                            parentId, content, {sibling: false}
                        ])
                    } else {
                        // Append to page
                        blockRef = await callLogseqApi('logseq.Editor.appendBlockInPage', [target, content])
                    }

                    // Set properties if provided
                    if (properties && blockRef?.uuid) {
                        for (const [key, value] of Object.entries(properties)) {
                            await callLogseqApi('logseq.Editor.upsertBlockProperty', [blockRef.uuid, key, value])
                        }
                    }

                    result = `Block created${blockRef?.uuid ? ` (${blockRef.uuid.substring(0, 8)}...)` : ''}.`
                    break
                }

                case 'update_block': {
                    const blockId = target.replace(/^\(\(|\)\)$/g, '')
                    if (!content) {
                        return {content: [{type: 'text', text: 'Error: content is required for update_block'}]}
                    }

                    await callLogseqApi('logseq.Editor.updateBlock', [blockId, content])
                    result = `Block ${blockId.substring(0, 8)}... updated.`
                    break
                }

                case 'delete_block': {
                    const blockId = target.replace(/^\(\(|\)\)$/g, '')
                    await callLogseqApi('logseq.Editor.removeBlock', [blockId])
                    result = `Block ${blockId.substring(0, 8)}... deleted.`
                    break
                }

                case 'append_to_page': {
                    if (!content) {
                        return {content: [{type: 'text', text: 'Error: content is required for append_to_page'}]}
                    }

                    // Ensure page exists
                    const page = await callLogseqApi('logseq.Editor.getPage', [target])
                    if (!page) {
                        await callLogseqApi('logseq.Editor.createPage', [target, {}])
                    }

                    const lines = content.split('\n').filter(l => l.trim())
                    for (const line of lines) {
                        await callLogseqApi('logseq.Editor.appendBlockInPage', [target, line])
                    }

                    result = `Added ${lines.length} block(s) to "${target}".`
                    break
                }

                case 'append_to_journal': {
                    if (!content) {
                        return {content: [{type: 'text', text: 'Error: content is required for append_to_journal'}]}
                    }

                    // Parse target date
                    let journalPageName: string
                    if (target === 'today') {
                        journalPageName = formatJournalDate(new Date())
                    } else if (target === 'yesterday') {
                        const yesterday = new Date()
                        yesterday.setDate(yesterday.getDate() - 1)
                        journalPageName = formatJournalDate(yesterday)
                    } else {
                        // Assume target is already a journal page name or date string
                        const date = new Date(target)
                        journalPageName = !isNaN(date.getTime()) ? formatJournalDate(date) : target
                    }

                    // Ensure journal page exists
                    const page = await callLogseqApi('logseq.Editor.getPage', [journalPageName])
                    if (!page) {
                        await callLogseqApi('logseq.Editor.createPage', [journalPageName, {'journal?': true}])
                    }

                    const lines = content.split('\n').filter(l => l.trim())
                    for (const line of lines) {
                        await callLogseqApi('logseq.Editor.appendBlockInPage', [journalPageName, line])
                    }

                    result = `Added ${lines.length} block(s) to journal "${journalPageName}".`
                    break
                }

                case 'set_property': {
                    if (!properties || Object.keys(properties).length === 0) {
                        return {content: [{type: 'text', text: 'Error: properties required for set_property'}]}
                    }

                    // Determine if target is a block or page
                    const isBlockId = /^[0-9a-f-]{8,}$/i.test(target.replace(/^\(\(|\)\)$/g, ''))

                    if (isBlockId) {
                        const blockId = target.replace(/^\(\(|\)\)$/g, '')
                        for (const [key, value] of Object.entries(properties)) {
                            await callLogseqApi('logseq.Editor.upsertBlockProperty', [blockId, key, value])
                        }
                        result = `Set ${Object.keys(properties).length} property(ies) on block.`
                    } else {
                        // For pages, we need to set properties on the first block
                        const blocks = await callLogseqApi('logseq.Editor.getPageBlocksTree', [target])
                        if (blocks?.[0]?.uuid) {
                            for (const [key, value] of Object.entries(properties)) {
                                await callLogseqApi('logseq.Editor.upsertBlockProperty', [blocks[0].uuid, key, value])
                            }
                            result = `Set ${Object.keys(properties).length} property(ies) on page "${target}".`
                        } else {
                            return {content: [{type: 'text', text: `Page "${target}" has no blocks to set properties on.`}]}
                        }
                    }
                    break
                }

                case 'remove_property': {
                    if (!properties || Object.keys(properties).length === 0) {
                        return {content: [{type: 'text', text: 'Error: properties required (specify keys to remove)'}]}
                    }

                    const isBlockId = /^[0-9a-f-]{8,}$/i.test(target.replace(/^\(\(|\)\)$/g, ''))

                    if (isBlockId) {
                        const blockId = target.replace(/^\(\(|\)\)$/g, '')
                        for (const key of Object.keys(properties)) {
                            await callLogseqApi('logseq.Editor.removeBlockProperty', [blockId, key])
                        }
                        result = `Removed ${Object.keys(properties).length} property(ies) from block.`
                    } else {
                        const blocks = await callLogseqApi('logseq.Editor.getPageBlocksTree', [target])
                        if (blocks?.[0]?.uuid) {
                            for (const key of Object.keys(properties)) {
                                await callLogseqApi('logseq.Editor.removeBlockProperty', [blocks[0].uuid, key])
                            }
                            result = `Removed ${Object.keys(properties).length} property(ies) from page "${target}".`
                        } else {
                            return {content: [{type: 'text', text: `Page "${target}" has no blocks.`}]}
                        }
                    }
                    break
                }
            }

            return {content: [{type: 'text', text: result}]}
        } catch (error: any) {
            return {content: [{type: 'text', text: `Write error: ${error.message}`}]}
        }
    }
)

// ============================================================================
// Tool 4: logseq_analyze - Unified Analysis Interface
// ============================================================================

server.tool(
    'logseq_analyze',
    {
        analysis: z.enum([
            'graph_overview', 'knowledge_gaps', 'orphan_pages',
            'todo_summary', 'tag_distribution', 'recent_activity'
        ]).describe('Type of analysis: graph_overview (stats), knowledge_gaps (disconnected topics), orphan_pages (no links), todo_summary (task status), tag_distribution (tag usage), recent_activity (recent changes)'),

        options: z.object({
            limit: z.number().optional().describe('Max items to include in analysis'),
            dateRange: z.string().optional().describe('Time period for recent_activity'),
            focusTag: z.string().optional().describe('Focus analysis on specific tag'),
        }).optional(),
    },
    async ({analysis, options = {}}) => {
        try {
            const {limit = 20, dateRange = 'last 7 days', focusTag} = options
            let output = ''

            switch (analysis) {
                case 'graph_overview': {
                    const pages = await callLogseqApi('logseq.Editor.getAllPages')

                    const journals = pages.filter((p: any) => p['journal?'])
                    const regularPages = pages.filter((p: any) => !p['journal?'])

                    // Get tags distribution via Datalog
                    let tagsQuery
                    try {
                        tagsQuery = await callLogseqApi('logseq.DB.datascriptQuery', [
                            '[:find ?name (count ?b) :where [?b :block/refs ?t] [?t :block/name ?name]]'
                        ])
                    } catch { tagsQuery = [] }

                    // Get todos
                    let todosQuery
                    try {
                        todosQuery = await callLogseqApi('logseq.DB.datascriptQuery', [
                            '[:find ?m (count ?b) :where [?b :block/marker ?m]]'
                        ])
                    } catch { todosQuery = [] }

                    output = `# Graph Overview\n\n`
                    output += `## Page Statistics\n`
                    output += `- **Total Pages:** ${pages.length}\n`
                    output += `- **Regular Pages:** ${regularPages.length}\n`
                    output += `- **Journal Pages:** ${journals.length}\n\n`

                    if (tagsQuery.length > 0) {
                        const topTags = tagsQuery
                            .sort((a: any, b: any) => b[1] - a[1])
                            .slice(0, 10)
                        output += `## Top Tags\n`
                        topTags.forEach((t: any) => {
                            output += `- #${t[0]} (${t[1]} references)\n`
                        })
                        output += '\n'
                    }

                    if (todosQuery.length > 0) {
                        output += `## Task Status\n`
                        todosQuery.forEach((t: any) => {
                            output += `- ${t[0]}: ${t[1]} items\n`
                        })
                        output += '\n'
                    }

                    // Recent pages
                    const recentPages = pages
                        .filter((p: any) => p.updatedAt)
                        .sort((a: any, b: any) => b.updatedAt - a.updatedAt)
                        .slice(0, 5)

                    if (recentPages.length > 0) {
                        output += `## Recently Modified\n`
                        recentPages.forEach((p: any) => {
                            const date = new Date(p.updatedAt).toLocaleDateString()
                            output += `- [[${p.originalName || p.name}]] (${date})\n`
                        })
                    }
                    break
                }

                case 'knowledge_gaps': {
                    // Find pages with few or no outgoing links
                    const pages = await callLogseqApi('logseq.Editor.getAllPages')
                    const linkRegex = /\[\[(.*?)\]\]/g

                    const pagesWithLinkCounts: Array<{name: string; outgoing: number; incoming: number}> = []

                    for (const page of pages.filter((p: any) => !p['journal?']).slice(0, 100)) {
                        const blocks = await callLogseqApi('logseq.Editor.getPageBlocksTree', [page.name])
                        const content = processBlocks(blocks || [], 0)
                        const matches = content.match(linkRegex) || []

                        pagesWithLinkCounts.push({
                            name: page.originalName || page.name,
                            outgoing: matches.length,
                            incoming: 0 // Would need backlinks query
                        })
                    }

                    // Pages with no outgoing links (potential knowledge gaps)
                    const gapPages = pagesWithLinkCounts
                        .filter(p => p.outgoing === 0)
                        .slice(0, limit)

                    output = `# Knowledge Gap Analysis\n\n`
                    output += `## Pages with No Outgoing Links\n`
                    output += `*These pages don't connect to other knowledge - consider adding links*\n\n`

                    if (gapPages.length === 0) {
                        output += 'No isolated pages found. Great connectivity!\n'
                    } else {
                        gapPages.forEach(p => {
                            output += `- [[${p.name}]]\n`
                        })
                    }
                    break
                }

                case 'orphan_pages': {
                    // Find pages with no backlinks
                    const orphanQuery = buildDatalogQuery('orphan_pages')
                    const orphans = await callLogseqApi('logseq.DB.datascriptQuery', [orphanQuery])

                    output = `# Orphan Pages\n\n`
                    output += `*Pages with no incoming links from other pages*\n\n`

                    const orphanList = orphans
                        .map((o: any) => o[0])
                        .filter((p: any) => !p['block/journal?'])
                        .slice(0, limit)

                    if (orphanList.length === 0) {
                        output += 'No orphan pages found.\n'
                    } else {
                        output += `Found ${orphanList.length} orphan page(s):\n\n`
                        orphanList.forEach((p: any) => {
                            output += `- [[${p['block/original-name'] || p['block/name']}]]\n`
                        })
                    }
                    break
                }

                case 'todo_summary': {
                    const todoQuery = buildDatalogQuery('todos')
                    const todos = await callLogseqApi('logseq.DB.datascriptQuery', [todoQuery])

                    // Group by marker
                    const byStatus: Record<string, any[]> = {}
                    todos.forEach((t: any) => {
                        const block = t[0] || t
                        const marker = block['block/marker'] || 'UNKNOWN'
                        if (!byStatus[marker]) byStatus[marker] = []
                        byStatus[marker].push(block)
                    })

                    output = `# Task Summary\n\n`
                    output += `**Total Tasks:** ${todos.length}\n\n`

                    for (const [status, items] of Object.entries(byStatus)) {
                        output += `## ${status} (${items.length})\n\n`
                        items.slice(0, 10).forEach((item: any) => {
                            const content = (item['block/content'] || '').replace(/^(TODO|DOING|NOW|LATER|WAITING|DONE)\s*/i, '')
                            output += `- ${content.substring(0, 80)}${content.length > 80 ? '...' : ''}\n`
                        })
                        if (items.length > 10) output += `- ... and ${items.length - 10} more\n`
                        output += '\n'
                    }
                    break
                }

                case 'tag_distribution': {
                    const tagQuery = '[:find ?name (count ?b) :where [?b :block/refs ?t] [?t :block/name ?name]]'
                    const tags = await callLogseqApi('logseq.DB.datascriptQuery', [tagQuery])

                    const sortedTags = tags
                        .filter((t: any) => t[0] && !t[0].startsWith('block/'))
                        .sort((a: any, b: any) => b[1] - a[1])

                    output = `# Tag Distribution\n\n`
                    output += `**Total Unique Tags:** ${sortedTags.length}\n\n`

                    if (focusTag) {
                        const focused = sortedTags.find((t: any) => t[0].toLowerCase() === focusTag.toLowerCase())
                        if (focused) {
                            output += `## Focus: #${focused[0]}\n`
                            output += `Referenced ${focused[1]} times\n\n`
                        }
                    }

                    output += `## Top Tags\n\n`
                    sortedTags.slice(0, limit).forEach((t: any, i: number) => {
                        const bar = '█'.repeat(Math.min(Math.ceil(t[1] / 5), 20))
                        output += `${i + 1}. #${t[0]} - ${t[1]} ${bar}\n`
                    })
                    break
                }

                case 'recent_activity': {
                    const {start, end} = parseDateRange(dateRange)
                    const pages = await callLogseqApi('logseq.Editor.getAllPages')

                    const recentPages = pages
                        .filter((p: any) => {
                            if (!p.updatedAt) return false
                            const updated = new Date(p.updatedAt)
                            return updated >= start && updated <= end
                        })
                        .sort((a: any, b: any) => b.updatedAt - a.updatedAt)
                        .slice(0, limit)

                    output = `# Recent Activity\n\n`
                    output += `*Period: ${start.toLocaleDateString()} - ${end.toLocaleDateString()}*\n\n`
                    output += `**Pages Modified:** ${recentPages.length}\n\n`

                    if (recentPages.length === 0) {
                        output += 'No activity in this period.\n'
                    } else {
                        recentPages.forEach((p: any) => {
                            const date = new Date(p.updatedAt).toLocaleString()
                            const icon = p['journal?'] ? '📅' : '📄'
                            output += `- ${icon} [[${p.originalName || p.name}]] - ${date}\n`
                        })
                    }
                    break
                }
            }

            return {content: [{type: 'text', text: output}]}
        } catch (error: any) {
            return {content: [{type: 'text', text: `Analysis error: ${error.message}`}]}
        }
    }
)

// ============================================================================
// Server Startup
// ============================================================================

const transport = new StdioServerTransport()
await server.connect(transport)
