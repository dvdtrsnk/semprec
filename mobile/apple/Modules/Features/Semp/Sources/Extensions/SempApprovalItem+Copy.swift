import CoreKit
import Foundation

// MARK: - Description
extension SempApprovalItem {

    /// What the request would do, in a few words. A request the app has no wording for reads as the call it makes.
    var title: String {
        switch descriptionKey {
        case "approval.itemPatch": String(localized: "semp.approval.itemPatch.title", bundle: .module)
        case "approval.relationPut": String(localized: "semp.approval.relationPut.title", bundle: .module)
        case "approval.relationSet": String(localized: "semp.approval.relationSet.title", bundle: .module)
        case "approval.itemDelete": String(localized: "semp.approval.itemDelete.title", bundle: .module)
        case "approval.propertyDelete": String(localized: "semp.approval.propertyDelete.title", bundle: .module)
        case "approval.databaseArchive": String(localized: "semp.approval.databaseArchive.title", bundle: .module)
        case "approval.viewDelete": String(localized: "semp.approval.viewDelete.title", bundle: .module)
        case "approval.relationDelete": String(localized: "semp.approval.relationDelete.title", bundle: .module)
        case "approval.pageRestore": String(localized: "semp.approval.pageRestore.title", bundle: .module)
        case "approval.pageReplace": String(localized: "semp.approval.pageReplace.title", bundle: .module)
        case "approval.pageConvertToBlock": String(localized: "semp.approval.pageConvert.title", bundle: .module)
        case "approval.journalMerge": String(localized: "semp.approval.journalMerge.title", bundle: .module)
        case "approval.mcpInvoke": String(localized: "semp.approval.mcpInvoke.title", bundle: .module)
        case "approval.moduleTool": String(localized: "semp.approval.moduleTool.title", bundle: .module)
        case "approval.emailSend": String(localized: "semp.approval.emailSend.title", bundle: .module)
        case "approval.heartbeatCreate": String(localized: "semp.approval.heartbeatCreate.title", bundle: .module)
        case "approval.heartbeatUpdate": String(localized: "semp.approval.heartbeatUpdate.title", bundle: .module)
        case "approval.heartbeatSetEnabled": String(localized: "semp.approval.heartbeatEnable.title", bundle: .module)
        case "approval.changesSeries": String(localized: "semp.approval.changesSeries.title", bundle: .module)
        default: callLabel ?? String(localized: "semp.approval.unknown.title", bundle: .module)
        }
    }

    /// What the request is about, from the names in its description; nil when the app has no wording for it.
    var target: String? {
        func text(_ name: String) -> String { descriptionParams[name] ?? "" }
        switch descriptionKey {
        case "approval.itemPatch", "approval.itemDelete", "approval.pageRestore", "approval.pageReplace":
            return format("semp.approval.itemInDatabase", text("itemName"), text("databaseName"))
        case "approval.relationPut", "approval.relationDelete":
            return format("semp.approval.twoItems", text("fromItemName"), text("toItemName"))
        case "approval.relationSet":
            return format("semp.approval.itemProperty", text("fromItemName"), text("propertyName"))
        case "approval.propertyDelete":
            return format("semp.approval.itemInDatabase", text("propertyName"), text("databaseName"))
        case "approval.databaseArchive":
            return format("semp.approval.one", text("databaseName"))
        case "approval.viewDelete":
            return format("semp.approval.itemInDatabase", text("viewName"), text("databaseName"))
        case "approval.pageConvertToBlock":
            return format("semp.approval.one", text("pageName"))
        case "approval.journalMerge":
            return format("semp.approval.twoItems", text("survivorName"), text("mergedName"))
        case "approval.mcpInvoke":
            return format("semp.approval.toolOnServer", text("toolName"), text("serverName"))
        case "approval.moduleTool":
            return format("semp.approval.one", text("toolName"))
        case "approval.emailSend":
            return format("semp.approval.email", text("mailboxName"), text("recipientCount"))
        case "approval.heartbeatCreate", "approval.heartbeatUpdate", "approval.heartbeatSetEnabled":
            return format("semp.approval.itemInProject", text("heartbeatName"), text("projectName"))
        case "approval.changesSeries":
            return format("semp.approval.one", text("taskName"))
        default:
            return nil
        }
    }

    /// How much the request can hurt, as a short label.
    var riskLabel: String {
        switch risk {
        case .irreversible: String(localized: "semp.approval.risk.irreversible", bundle: .module)
        case .outbound: String(localized: "semp.approval.risk.outbound", bundle: .module)
        case .breaksLink: String(localized: "semp.approval.risk.breaksLink", bundle: .module)
        case .write: String(localized: "semp.approval.risk.write", bundle: .module)
        }
    }

    /// Where the request came from, written for the line under its title.
    var sourceLabel: String {
        switch origin {
        case .chat:
            threadTitle.map { format("semp.approval.source.chatNamed", $0) }
                ?? String(localized: "semp.approval.source.chat", bundle: .module)
        case .tick:
            heartbeatName.map { format("semp.approval.source.tickNamed", $0) }
                ?? String(localized: "semp.approval.source.tick", bundle: .module)
        case .mcp: String(localized: "semp.approval.source.mcp", bundle: .module)
        }
    }

    /// How the request stands once it was decided, or nil while it waits.
    var outcomeLabel: String? {
        switch decision {
        case .pending: nil
        case .approving, .rejecting: String(localized: "semp.approval.outcome.sending", bundle: .module)
        case .queued: String(localized: "semp.approval.outcome.queued", bundle: .module)
        case .executed: String(localized: "semp.approval.outcome.executed", bundle: .module)
        case .rejected: String(localized: "semp.approval.outcome.rejected", bundle: .module)
        case .conflict: conflictLabel
        }
    }

    private var conflictLabel: String {
        switch conflictKey {
        case "approval.conflict.deleted": String(localized: "semp.approval.conflict.deleted", bundle: .module)
        case "approval.conflict.provenanceChanged":
            String(localized: "semp.approval.conflict.provenanceChanged", bundle: .module)
        case "approval.conflict.archived": String(localized: "semp.approval.conflict.archived", bundle: .module)
        default: String(localized: "semp.approval.conflict.other", bundle: .module)
        }
    }

    private func format(_ key: String.LocalizationValue, _ arguments: String...) -> String {
        String(format: String(localized: key, bundle: .module), locale: .current, arguments: arguments)
    }
}
