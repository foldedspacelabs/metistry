// Usage — what the models cost and which one each tier runs on: the compute
// report with its spend, the live model lists and the catalogue grouped by
// model, and the writes a remote client may also make — an assignment (and
// removing one), and a spending limit (design-build-plan §2.3, §2.16). The
// popover (screen 17, usage-view.swift) also reads three named queries: the
// month's days (`spend`), who spent it (`spend_by_actor`) and AWS beside it
// (`aws_costs_daily`). Providers, keys and base URLs are the Mac's alone,
// through `metistry compute providers` (M16), never a route.

import Foundation

public protocol UsageStore: Sendable {
    /// route: GET /api/compute
    func compute() async -> Result<ConsoleCompute, ConsoleError>
    /// route: GET /api/compute/models
    func computeModels(provider: String?) async -> Result<ComputeModelsReply, ConsoleError>
    /// route: GET /api/compute/catalogue
    func computeCatalogue(query: String?, provider: String?, refresh: Bool) async -> Result<ComputeCatalogueReply, ConsoleError>
    /// route: POST /api/compute/assign
    func assignCompute(_ target: ComputeAssignTarget, model: String, effort: String?) async -> Result<ComputeWriteResult, ConsoleError>
    /// route: POST /api/compute/unassign
    func unassignCompute(_ target: ComputeAssignTarget) async -> Result<ComputeWriteResult, ConsoleError>
    /// route: POST /api/compute/budget
    func setComputeBudget(scope: String, daily: Double?, monthly: Double?, action: String) async -> Result<ComputeWriteResult, ConsoleError>
    /// route: POST /api/compute/providers/test
    func testComputeProvider(_ name: String, complete: Bool) async -> Result<ComputeProviderTestReply, ConsoleError>
    /// route: GET /api/q/spend
    func spend(days: Int?) async -> Result<SpendRows, ConsoleError>
    /// route: GET /api/q/spend_by_actor
    func spendByActor(days: Int?) async -> Result<SpendByActorList, ConsoleError>
    /// route: GET /api/q/aws_costs_daily
    func awsCostsDaily(days: Int?) async -> Result<AwsCostDays, ConsoleError>
}

extension ConsoleStores: UsageStore {
    public func compute() async -> Result<ConsoleCompute, ConsoleError> { await api.compute() }
    public func computeModels(provider: String?) async -> Result<ComputeModelsReply, ConsoleError> { await api.computeModels(provider: provider) }

    public func computeCatalogue(query: String?, provider: String?, refresh: Bool) async -> Result<ComputeCatalogueReply, ConsoleError> {
        await api.computeCatalogue(query: query, provider: provider, refresh: refresh)
    }

    public func assignCompute(_ target: ComputeAssignTarget, model: String, effort: String?) async -> Result<ComputeWriteResult, ConsoleError> {
        await api.assignCompute(target, model: model, effort: effort)
    }

    public func unassignCompute(_ target: ComputeAssignTarget) async -> Result<ComputeWriteResult, ConsoleError> {
        await api.unassignCompute(target)
    }

    public func setComputeBudget(scope: String, daily: Double?, monthly: Double?, action: String) async -> Result<ComputeWriteResult, ConsoleError> {
        await api.setComputeBudget(scope: scope, daily: daily, monthly: monthly, action: action)
    }

    public func testComputeProvider(_ name: String, complete: Bool) async -> Result<ComputeProviderTestReply, ConsoleError> {
        await api.testComputeProvider(name, complete: complete)
    }

    public func spend(days: Int?) async -> Result<SpendRows, ConsoleError> { await api.spend(days: days) }
    public func spendByActor(days: Int?) async -> Result<SpendByActorList, ConsoleError> { await api.spendByActor(days: days) }
    public func awsCostsDaily(days: Int?) async -> Result<AwsCostDays, ConsoleError> { await api.awsCostsDaily(days: days) }
}
